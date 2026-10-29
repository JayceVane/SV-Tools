//! 图片剪贴板入口；PNG解码和系统调用在NAPI工作线程执行。
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

#[cfg(windows)]
mod windows;

const MAX_PNG_BYTES: usize = 32 * 1024 * 1024;

pub struct ClipboardImageTask {
    png: Vec<u8>,
}

impl Task for ClipboardImageTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        #[cfg(windows)]
        return windows::write_png(&self.png)
            .map_err(|message| Error::new(Status::GenericFailure, message));
        #[cfg(not(windows))]
        Err(Error::new(
            Status::GenericFailure,
            "当前系统暂不支持原生图片剪贴板",
        ))
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

/// 将有界PNG复制为系统图片。解码失败不触碰剪贴板，成功后数据由系统持有。
#[napi]
pub fn write_clipboard_png(png: Buffer) -> Result<AsyncTask<ClipboardImageTask>> {
    if png.len() > MAX_PNG_BYTES {
        return Err(Error::new(Status::InvalidArg, "剪贴板PNG超过32 MiB"));
    }
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(Error::new(Status::InvalidArg, "无效PNG图片"));
    }
    Ok(AsyncTask::new(ClipboardImageTask { png: png.to_vec() }))
}
