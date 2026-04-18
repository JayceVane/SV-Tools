use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

use svtools::config::FormatOptions;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        print_usage(&args[0]);
        std::process::exit(1);
    }

    // Parse options from CLI args
    let mut options = FormatOptions::default();
    let mut input_files: Vec<String> = Vec::new();
    let mut output_file: Option<String> = None;
    let mut in_place = false;
    let mut check_mode = false;
    let mut i = 1;

    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => {
                print_usage(&args[0]);
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("svtools {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "-o" | "--output" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Error: --output requires a filename");
                    std::process::exit(1);
                }
                output_file = Some(args[i].clone());
            }
            "-i" | "--inplace" => {
                in_place = true;
            }
            "-c" | "--check" => {
                check_mode = true;
            }
            "--tab-size" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Error: --tab-size requires a number");
                    std::process::exit(1);
                }
                options.nb_space = Some(args[i].parse().unwrap_or_else(|_| {
                    eprintln!("Error: invalid tab-size");
                    std::process::exit(1);
                }));
            }
            "--use-tab" => {
                options.use_tab = Some(true);
            }
            "--style" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Error: --style requires '1tbs' or 'gnu'");
                    std::process::exit(1);
                }
                options.indent_style = Some(args[i].clone());
            }
            "--reindent-only" => {
                options.reindent_only = Some(true);
            }
            "--no-align-comma" => {
                options.align_comma = Some(false);
            }
            "--no-inst-align" => {
                options.inst_align_port = Some(false);
            }
            "--one-decl-per-line" => {
                options.one_decl_per_line = Some(true);
            }
            "--max-empty-lines" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Error: --max-empty-lines requires a number");
                    std::process::exit(1);
                }
                options.max_consecutive_empty_lines = Some(args[i].parse().unwrap_or_else(|_| {
                    eprintln!("Error: invalid max-empty-lines");
                    std::process::exit(1);
                }));
            }
            "-" => {
                // Read from stdin
                let mut text = String::new();
                io::stdin().read_to_string(&mut text).unwrap();
                let result = format_text(&text, &options);
                if check_mode {
                    if result != text {
                        eprintln!("File would be reformatted");
                        std::process::exit(1);
                    }
                } else if let Some(ref out) = output_file {
                    fs::write(out, &result).unwrap_or_else(|e| {
                        eprintln!("Error writing {}: {}", out, e);
                        std::process::exit(1);
                    });
                } else {
                    io::stdout().write_all(result.as_bytes()).unwrap();
                }
                return;
            }
            arg if arg.starts_with('-') => {
                eprintln!("Unknown option: {}", arg);
                std::process::exit(1);
            }
            _ => {
                input_files.push(args[i].clone());
            }
        }
        i += 1;
    }

    if input_files.is_empty() {
        // Read from stdin if no files specified
        let mut text = String::new();
        io::stdin().read_to_string(&mut text).unwrap();
        let result = format_text(&text, &options);
        if check_mode {
            if result != text {
                std::process::exit(1);
            }
        } else {
            io::stdout().write_all(result.as_bytes()).unwrap();
        }
        return;
    }

    let mut had_diff = false;
    for filepath in &input_files {
        let text = fs::read_to_string(filepath).unwrap_or_else(|e| {
            eprintln!("Error reading {}: {}", filepath, e);
            std::process::exit(1);
        });

        let result = format_text(&text, &options);

        if check_mode {
            if result != text {
                eprintln!("would reformat: {}", filepath);
                had_diff = true;
            }
        } else if in_place {
            fs::write(filepath, &result).unwrap_or_else(|e| {
                eprintln!("Error writing {}: {}", filepath, e);
                std::process::exit(1);
            });
        } else if let Some(ref out) = output_file {
            fs::write(out, &result).unwrap_or_else(|e| {
                eprintln!("Error writing {}: {}", out, e);
                std::process::exit(1);
            });
        } else {
            io::stdout().write_all(result.as_bytes()).unwrap();
        }
    }

    if check_mode && had_diff {
        std::process::exit(1);
    }
}

fn format_text(text: &str, options: &FormatOptions) -> String {
    let indent_style = options.indent_style().to_string();
    let preprocessed = svtools::preprocess::preprocess_text(text, &indent_style);
    let mut beautifier = svtools::beautifier::VerilogBeautifier::new(options.clone());
    let formatted = beautifier.beautify_text(&preprocessed);
    let max_empty = options.max_consecutive_empty_lines();
    svtools::postprocess::postprocess_text(&formatted, max_empty)
}

fn print_usage(program: &str) {
    let name = Path::new(program)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    println!(
        r#"svtools {} - SystemVerilog formatter

USAGE:
    {name} [OPTIONS] [FILES...]

    When FILES are omitted, reads from stdin and writes to stdout.

OPTIONS:
    -i, --inplace           Format files in place
    -c, --check             Check if files need formatting (exit 1 if yes)
    -o, --output <FILE>     Write output to FILE
    --tab-size <N>          Number of spaces per indent (default: 4)
    --use-tab               Use tab characters instead of spaces
    --style <STYLE>         Indent style: '1tbs' or 'gnu' (default: 1tbs)
    --reindent-only         Only fix indentation, no alignment
    --no-align-comma        Disable comma/semicolon alignment
    --no-inst-align         Disable instance port alignment
    --one-decl-per-line     Put each declaration on its own line
    --max-empty-lines <N>   Max consecutive empty lines (default: 1)
    -h, --help              Show this help
    -V, --version           Show version

EXAMPLES:
    {name} file.sv                      Format and print to stdout
    {name} -i file1.sv file2.sv         Format files in place
    {name} -c *.sv                      Check if files need formatting
    {name} --tab-size 2 file.sv         Format with 2-space indent
    cat file.sv | {name}                Format from stdin
"#,
        env!("CARGO_PKG_VERSION")
    );
}
