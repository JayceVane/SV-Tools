//! Win32的HGLOBAL内存所有权只在SetClipboardData成功后转移；无shell或外部进程。
use std::{ffi::c_void, io::Cursor, ptr, sync::Mutex, thread, time::Duration};

type Handle = *mut c_void;
const MAX_SIDE: u32 = 16384;
const MAX_PIXELS: usize = 32 * 1024 * 1024;
const HEADER_BYTES: usize = 40;
const CF_DIB: u32 = 8;
const GMEM_MOVEABLE: u32 = 0x0002;
const OPEN_ATTEMPTS: usize = 10;
const OPEN_DELAY: Duration = Duration::from_millis(20);
static COPYING: Mutex<()> = Mutex::new(());

#[link(name = "kernel32")]
extern "system" {
    fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
    fn GlobalLock(handle: Handle) -> Handle;
    fn GlobalUnlock(handle: Handle) -> i32;
    fn GlobalFree(handle: Handle) -> Handle;
    fn GetLastError() -> u32;
    #[cfg(test)]
    fn GlobalSize(handle: Handle) -> usize;
}
#[link(name = "user32")]
extern "system" {
    fn CreateWindowExW(
        ex_style: u32,
        class: *const u16,
        name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: Handle,
        menu: Handle,
        instance: Handle,
        param: Handle,
    ) -> Handle;
    fn DestroyWindow(window: Handle) -> i32;
    fn OpenClipboard(window: Handle) -> i32;
    fn CloseClipboard() -> i32;
    fn EmptyClipboard() -> i32;
    fn SetClipboardData(format: u32, memory: Handle) -> Handle;
    fn RegisterClipboardFormatW(name: *const u16) -> u32;
    #[cfg(test)]
    fn GetClipboardData(format: u32) -> Handle;
}

fn system_error(action: &str) -> String {
    format!("{}（Windows错误{}）", action, unsafe { GetLastError() })
}

struct GlobalMemory(Handle);
impl GlobalMemory {
    fn copy(bytes: &[u8]) -> Result<Self, String> {
        let memory = Self(unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) });
        if memory.0.is_null() {
            return Err(system_error("分配剪贴板内存失败"));
        }
        let destination = unsafe { GlobalLock(memory.0) };
        if destination.is_null() {
            return Err(system_error("锁定剪贴板内存失败"));
        }
        // SAFETY: 可移动HGLOBAL已锁定，分配长度与源切片一致；提交前释放锁。
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), destination.cast(), bytes.len());
            GlobalUnlock(memory.0);
        }
        Ok(memory)
    }

    fn submit(mut self, format: u32) -> Result<(), String> {
        if unsafe { SetClipboardData(format, self.0) }.is_null() {
            return Err(system_error("提交图片到剪贴板失败"));
        }
        self.0 = ptr::null_mut(); // 系统现在拥有内存；Drop不得释放。
        Ok(())
    }
}
impl Drop for GlobalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                GlobalFree(self.0);
            }
        }
    }
}

struct Owner(Handle);
impl Owner {
    fn create() -> Result<Self, String> {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        // 消息窗口不显示UI；有效owner避免OpenClipboard(NULL)后的SetClipboardData失败。
        let window = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                0,
                0,
                0,
                0,
                0,
                (-3isize) as Handle,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if window.is_null() {
            return Err(system_error("创建剪贴板所有者窗口失败"));
        }
        Ok(Self(window))
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.0);
        }
    }
}

struct Clipboard;
impl Clipboard {
    fn open(owner: &Owner) -> Result<Self, String> {
        for attempt in 0..OPEN_ATTEMPTS {
            if unsafe { OpenClipboard(owner.0) } != 0 {
                return Ok(Self);
            }
            if attempt + 1 < OPEN_ATTEMPTS {
                thread::sleep(OPEN_DELAY);
            }
        }
        Err(system_error(
            "剪贴板正被其它程序占用或访问被拒绝，请稍后重试",
        ))
    }
}
impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}

fn buffer(length: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| "图片过大，无法分配剪贴板内存")?;
    bytes.resize(length, 0);
    Ok(bytes)
}

/// PNG转32位top-down DIB；PNG格式保留原始透明度，传统DIB将透明像素合成到白底。
fn decode_dib(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: MAX_PIXELS * 4,
    });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("PNG解码失败：{}", error))?;
    let info = reader.info();
    let width = info.width;
    let height = info.height;
    let pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or("PNG尺寸溢出")?;
    if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE || pixels > MAX_PIXELS {
        return Err("PNG尺寸超过剪贴板预算（单边16384、总计32M像素）".into());
    }
    let length = reader
        .output_buffer_size()
        .filter(|size| *size <= MAX_PIXELS * 4)
        .ok_or("PNG解码尺寸超过预算")?;
    let mut decoded = buffer(length)?;
    let frame = reader
        .next_frame(&mut decoded)
        .map_err(|error| format!("PNG解码失败：{}", error))?;
    reader
        .finish()
        .map_err(|error| format!("PNG校验失败：{}", error))?;
    let channels = match frame.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Grayscale => 1,
        _ => return Err("PNG颜色格式不支持".into()),
    };
    if frame.bit_depth != png::BitDepth::Eight
        || frame.width != width
        || frame.height != height
        || frame.buffer_size() != pixels * channels
    {
        return Err("PNG像素布局无效".into());
    }
    let mut dib = buffer(HEADER_BYTES + pixels * 4)?;
    dib[0..4].copy_from_slice(&(HEADER_BYTES as u32).to_le_bytes());
    dib[4..8].copy_from_slice(&(width as i32).to_le_bytes());
    dib[8..12].copy_from_slice(&(-(height as i32)).to_le_bytes());
    dib[12..14].copy_from_slice(&1u16.to_le_bytes());
    dib[14..16].copy_from_slice(&32u16.to_le_bytes());
    dib[20..24].copy_from_slice(&((pixels * 4) as u32).to_le_bytes());
    for (source, destination) in decoded[..frame.buffer_size()]
        .chunks_exact(channels)
        .zip(dib[HEADER_BYTES..].chunks_exact_mut(4))
    {
        let (r, g, b, a) = match channels {
            4 => (source[0], source[1], source[2], source[3]),
            3 => (source[0], source[1], source[2], 255),
            2 => (source[0], source[0], source[0], source[1]),
            _ => (source[0], source[0], source[0], 255),
        };
        let blend =
            |value: u8| ((value as u32 * a as u32 + 255 * (255 - a as u32) + 127) / 255) as u8;
        destination.copy_from_slice(&[blend(b), blend(g), blend(r), 255]);
    }
    Ok(dib)
}

/// 完整准备所有数据后才打开剪贴板；占用重试有界，跨面板复制不会同时分配大图。
pub(super) fn write_png(png: &[u8]) -> Result<(), String> {
    let _copying = COPYING
        .try_lock()
        .map_err(|_| "另一个图片复制正在进行，请稍后重试")?;
    let dib = decode_dib(png)?;
    let png_memory = GlobalMemory::copy(png)?;
    let dib_memory = GlobalMemory::copy(&dib)?;
    drop(dib);
    let format: Vec<u16> = "PNG\0".encode_utf16().collect();
    let png_format = unsafe { RegisterClipboardFormatW(format.as_ptr()) };
    if png_format == 0 {
        return Err(system_error("注册PNG剪贴板格式失败"));
    }
    let owner = Owner::create()?;
    let _clipboard = Clipboard::open(&owner)?;
    if unsafe { EmptyClipboard() } == 0 {
        return Err(system_error("初始化剪贴板失败"));
    }
    // PNG供支持透明图片的软件使用，CF_DIB保证常规图片粘贴兼容性。
    png_memory.submit(png_format)?;
    dib_memory.submit(CF_DIB)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(width: u32, height: u32, color: png::ColorType, pixels: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        {
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(pixels).unwrap();
        }
        bytes
    }

    #[test]
    fn dib_preserves_orientation_channels_and_alpha_compositing() {
        let image = png(
            2,
            2,
            png::ColorType::Rgba,
            &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0],
        );
        let dib = decode_dib(&image).unwrap();
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), -2);
        assert_eq!(
            &dib[HEADER_BYTES..],
            &[0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]
        );
    }

    #[test]
    fn rgb_and_grayscale_decode_without_a_clipboard_side_effect() {
        assert_eq!(
            &decode_dib(&png(1, 1, png::ColorType::Rgb, &[10, 20, 30])).unwrap()[HEADER_BYTES..],
            &[30, 20, 10, 255]
        );
        assert_eq!(
            &decode_dib(&png(1, 1, png::ColorType::Grayscale, &[70])).unwrap()[HEADER_BYTES..],
            &[70, 70, 70, 255]
        );
        assert!(decode_dib(b"not png").is_err());
        let mut broken = png(1, 1, png::ColorType::Rgb, &[0, 0, 0]);
        broken.truncate(broken.len() - 10);
        assert!(decode_dib(&broken).is_err());
    }

    #[test]
    #[ignore = "显式验收：会将2×2测试图片写入系统剪贴板"]
    fn system_clipboard_roundtrip_and_busy_retry() {
        let image = png(
            2,
            2,
            png::ColorType::Rgba,
            &[
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ],
        );
        write_png(&image).unwrap();
        let owner = Owner::create().unwrap();
        let _clipboard = Clipboard::open(&owner).unwrap();
        let name: Vec<u16> = "PNG\0".encode_utf16().collect();
        let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
        for (kind, expected) in [
            (format, image.clone()),
            (CF_DIB, decode_dib(&image).unwrap()),
        ] {
            let memory = unsafe { GetClipboardData(kind) };
            assert!(!memory.is_null());
            assert!(unsafe { GlobalSize(memory) } >= expected.len());
            let data = unsafe { GlobalLock(memory) };
            assert!(!data.is_null());
            let actual = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), expected.len()) };
            assert_eq!(actual, expected);
            unsafe {
                GlobalUnlock(memory);
            }
        }
        // 当前线程持有剪贴板时，另一个线程必须有界失败，不能清空既有图片。
        let error = thread::spawn(move || write_png(&image))
            .join()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("占用"));
        assert!(!unsafe { GetClipboardData(CF_DIB) }.is_null());
    }
}
