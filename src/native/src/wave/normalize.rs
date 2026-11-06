//! VCD 体规范化：wellen 的 body 解析器**按行推进**，要求每个 token 各自成行。
//!
//! 实测（`probe_dumpvars_wrapper`）：
//! - `$enddefinitions $end\n$dumpvars\n0!\n$end\n#10\n1!` → 时间表 `[0,10]`（正常）
//! - `$enddefinitions $end $dumpvars 0! $end #10 1!`（单行）→ 时间表**空**，静默失败
//!
//! 很多工具（含本项目测试夹具、部分仿真器）会把 body 挤在一行，wellen 会因此
//! 解析出零事件而不报错。这里在检测到「文件确有 body 内容但时间表为空」时，
//! 生成一份规范化副本再解析。
//!
//! 规范化只做三件事：在 `#<time>` 前断行、在 value token 与其标识符之间断行、
//! 保持 `$` 命令块的 `$end` 独立成行。不改动任何语义。

use std::path::{Path, PathBuf};

/// 判断一个文件是否需要规范化：存在 body 内容但解析结果为空。
/// 由调用方在解析失败/空结果时决定是否重试，避免对正常文件多读一遍。
pub fn needs_normalization(file: &Path, time_steps: usize) -> bool {
    if time_steps > 0 {
        return false;
    }
    has_body_content(file)
}

/// 文件在 `$enddefinitions` 之后是否有非空内容。
fn has_body_content(file: &Path) -> bool {
    use std::io::Read;
    const MAX_SCAN_BYTES: u64 = 8 * 1024 * 1024;
    let Ok(handle) = std::fs::File::open(file) else { return false };
    let mut buffer = Vec::new();
    if handle.take(MAX_SCAN_BYTES).read_to_end(&mut buffer).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&buffer);
    split_off_header(&text).is_some_and(|(_, body)| !body.trim().is_empty())
}

/// 把文本切成 (head, body)：head 含 `$enddefinitions $end`（有换行时含到行尾）。
///
/// `write_normalized` 与 `has_body_content` 共用这一处切分，避免两者对
/// 「body 从哪里开始」判断不一致——这类不一致曾导致规范化对单行文件静默失效。
fn split_off_header(text: &str) -> Option<(&str, &str)> {
    const KEYWORD: &str = "$enddefinitions";
    let position = text.find(KEYWORD)?;
    let after = &text[position + KEYWORD.len()..];
    let header_end = match after.find('\n') {
        Some(offset) => position + KEYWORD.len() + offset + 1,
        None => match after.find("$end") {
            Some(offset) => position + KEYWORD.len() + offset + "$end".len(),
            None => text.len(),
        },
    };
    Some((&text[..header_end], &text[header_end..]))
}

/// 生成规范化副本，返回临时文件路径；调用方负责删除。
///
/// 只处理 `$enddefinitions` 之后的部分：头部声明由 wellen 自行处理（已经工作正常），
/// 重排 body 才能保证 `$var` 的符号顺序与 `header::read_symbols` 一致。
pub fn write_normalized(file: &Path, destination: &Path) -> std::io::Result<PathBuf> {
    use std::io::{Read, Write};
    const MAX_BYTES: u64 = 2048 * 1024 * 1024;
    let handle = std::fs::File::open(file)?;
    let mut buffer = Vec::new();
    handle.take(MAX_BYTES).read_to_end(&mut buffer)?;
    let text = String::from_utf8_lossy(&buffer);

    let Some((head, body)) = split_off_header(&text) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "VCD 缺少 $enddefinitions",
        ));
    };


    let mut output = String::with_capacity(text.len() + text.len() / 32);
    output.push_str(head);
    // 单行输入时 head 切在 `$end` 之后（无尾随换行），必须补一个，
    // 否则第一个 body token 会粘在 `$enddefinitions $end` 同一行上。
    if !head.is_empty() && !head.ends_with('\n') {
        output.push('\n');
    }
    let mut tokens = Tokenizer::new(body);
    let mut last_was_command = false;
    while let Some(token) = tokens.next_token() {
        let starts_command = token.starts_with('$');
        let ends_command = token == "$end";
        // `$` 命令块的 `$end` 之后加空行便于阅读，但语义上不必要；这里只保证换行。
        output.push_str(token);
        output.push('\n');
        if ends_command {
            last_was_command = false;
        } else if starts_command {
            last_was_command = true;
        } else {
            let _ = last_was_command;
        }
    }

    let mut target = std::fs::File::create(destination)?;
    target.write_all(output.as_bytes())?;
    Ok(destination.to_path_buf())
}

/// 极简 tokenizer：按空白切分，但把 `#` 时间戳与紧随其后的数字视为整体，
/// 并把 `$` 命令与参数分开（`$enddefinitions` 已在头部处理）。
struct Tokenizer<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Tokenizer<'a> {
    fn new(text: &'a str) -> Self {
        Self { bytes: text.as_bytes(), position: 0 }
    }

    fn next_token(&mut self) -> Option<&'a str> {
        while self.position < self.bytes.len() && self.bytes[self.position].is_ascii_whitespace() {
            self.position += 1;
        }
        if self.position >= self.bytes.len() {
            return None;
        }
        let start = self.position;
        while self.position < self.bytes.len() && !self.bytes[self.position].is_ascii_whitespace() {
            self.position += 1;
        }
        std::str::from_utf8(&self.bytes[start..self.position]).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(name: &str, text: &str) -> String {
        let directory = std::env::temp_dir().join("svtools-wave-normalize");
        std::fs::create_dir_all(&directory).expect("create temp dir");
        let source = directory.join(format!("{}-source.vcd", name));
        let target = directory.join(format!("{}-normalized.vcd", name));
        std::fs::write(&source, text).expect("write source");
        write_normalized(&source, &target).expect("normalize");
        let result = std::fs::read_to_string(&target).expect("read normalized");
        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_file(target);
        result
    }

    #[test]
    fn splits_single_line_body_into_tokens() {
        let output = round_trip("single", "$scope module tb $end $var wire 1 ! clk $end $upscope $end $enddefinitions $end $dumpvars 0! $end #10 1! #20 0!");
        let body = output.split("$enddefinitions $end").nth(1).expect("body present");
        let tokens: Vec<&str> = body.split_whitespace().collect();
        assert_eq!(tokens, vec!["$dumpvars", "0!", "$end", "#10", "1!", "#20", "0!"]);
        // 每个 token 独立成行
        assert_eq!(body.lines().filter(|line| !line.trim().is_empty()).count(), tokens.len());
    }

    #[test]
    fn already_normalized_input_is_stable() {
        let original = "$scope module tb $end\n$var wire 1 ! clk $end\n$upscope $end\n$enddefinitions $end\n$dumpvars\n0!\n$end\n#10\n1!\n";
        let output = round_trip("stable", original);
        let tokens: Vec<&str> = output.split_whitespace().collect();
        assert_eq!(tokens, vec!["$scope", "module", "tb", "$end", "$var", "wire", "1", "!", "clk", "$end", "$upscope", "$end", "$enddefinitions", "$end", "$dumpvars", "0!", "$end", "#10", "1!"]);
    }

    #[test]
    fn does_not_touch_header_declarations() {
        let output = round_trip("header", "$date today $end\n$version v1 $end\n$scope module tb $end $var wire 1 ! c $end $upscope $end $enddefinitions $end 0! #5 1!");
        // 头部原样保留（含 `$date today $end` 这一行）
        assert!(output.starts_with("$date today $end\n$version v1 $end\n"));
        assert!(output.contains("$var wire 1 ! c $end"));
    }

    #[test]
    fn missing_enddefinitions_reports_error() {
        let directory = std::env::temp_dir().join("svtools-wave-normalize");
        std::fs::create_dir_all(&directory).expect("create temp dir");
        let source = directory.join("no-end.vcd");
        std::fs::write(&source, "$scope module tb $end").expect("write");
        let result = write_normalized(&source, &directory.join("out.vcd"));
        let _ = std::fs::remove_file(&source);
        assert!(result.is_err(), "缺少 $enddefinitions 必须报错");
    }

    #[test]
    fn empty_body_needs_no_normalization() {
        let directory = std::env::temp_dir().join("svtools-wave-normalize");
        std::fs::create_dir_all(&directory).expect("create temp dir");
        let source = directory.join("empty.vcd");
        std::fs::write(&source, "$scope module tb $end\n$var wire 1 ! c $end\n$upscope $end\n$enddefinitions $end\n").expect("write");
        assert!(!needs_normalization(&source, 0), "空 body 不需要规范化");
        let _ = std::fs::remove_file(&source);
    }
}



