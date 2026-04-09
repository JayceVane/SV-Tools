use chrono::Local;
use std::path::Path;

/// Generate header from template with placeholder replacement.
/// Replicates Python `vg_core.generate_header_template()`.
pub fn generate_header_template(template: &str, file_name: &str, _tab_size: u32) -> String {
    let now = Local::now();
    let fname = Path::new(file_name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    template
        .replace("{YEAR}", &now.format("%Y").to_string())
        .replace("{FILE}", &fname)
        .replace("{DATE}", &now.format("%Y-%m-%d").to_string())
        .replace("{TIME}", &now.format("%H:%M:%S").to_string())
        .replace("{RDATE}", &now.format("%Y-%m-%d").to_string())
        .replace("{RTIME}", &now.format("%H:%M:%S").to_string())
}
