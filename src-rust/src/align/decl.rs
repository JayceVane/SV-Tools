use regex::Regex;

use crate::config::FormatOptions;

/// Align signal declarations: `[scope::]type [signed|unsigned] [bitwidth] signal list`
/// Replicates Python `VerilogBeautifier.alignDecl()`.
pub fn align_decl(txt: &str, options: &FormatOptions, indent: &str, indent_space: &str) -> String {
    let re_decl = Regex::new(
        r#"^[ \t]*(?:(?P<param>localparam|parameter|local|protected)\s+)?(?P<scope>\w+\:\:)?(?P<type>[A-Za-z_]\w*)[ \t]+(?P<sign>signed\b|unsigned\b)?[ \t]*(?P<bw>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)[ \t]*(?P<name>[A-Za-z_]\w*)[ \t]*(?P<array>(?:\[[\w\*\(\)\/><\:\-\+`\$\s]+\][ \t]*)*)(=\s*(?P<init>[^;]+))?(?P<sig_list>,[\w, \t]*)?;[ \t]*(?P<comment>.*)"#,
    )
    .unwrap();

    let lines: Vec<&str> = txt.split('\n').collect();
    let mut lines_match: Vec<(&str, Option<regex::Captures>, usize)> = Vec::new();
    let mut len_max: HashMap<usize, DeclWidths> = HashMap::new();
    let one_decl_per_line = options.one_decl_per_line();

    // First pass: collect matches and calculate column widths
    for l in &lines {
        if let Some(m) = re_decl.captures(l) {
            let ilvl = get_indent_level(l, options, indent, indent_space);
            let widths = len_max.entry(ilvl).or_insert_with(DeclWidths::new);

            for (k, val) in m.iter().enumerate() {
                if let Some(v) = val {
                    let w = v.as_str().trim();
                    match k {
                        1 => widths.param = widths.param.max(w.len()),
                        2 => widths.scope = widths.scope.max(w.len()),
                        3 => {
                            let t = w;
                            let is_standard =
                                ["logic", "wire", "reg", "bit", "int", "integer"].contains(&t);
                            if is_standard {
                                widths.type_col = widths.type_col.max(t.len());
                            } else if m.name("bw").is_some() {
                                widths.type_user_pa = widths.type_user_pa.max(t.len());
                            } else {
                                widths.type_user = widths.type_user.max(t.len());
                            }
                            widths.type_full = widths.type_full.max(t.len());
                        }
                        4 => widths.sign = widths.sign.max(w.len()),
                        5 => {
                            // Bitwidth - per dimension
                            let bw_clean = Regex::new(r"\s*").unwrap().replace_all(w, "");
                            for (i, inner) in Regex::new(r"\[(.+?)\]")
                                .unwrap()
                                .find_iter(&bw_clean)
                                .enumerate()
                            {
                                let content = &inner.as_str()[1..inner.as_str().len() - 1];
                                if i >= widths.bw.len() {
                                    widths.bw.push(content.len());
                                } else {
                                    widths.bw[i] = widths.bw[i].max(content.len());
                                }
                            }
                        }
                        6 => widths.name = widths.name.max(w.len()),
                        7 => {
                            let arr_clean = Regex::new(r"\s*").unwrap().replace_all(w, "");
                            for (i, inner) in Regex::new(r"\[(.+?)\]")
                                .unwrap()
                                .find_iter(&arr_clean)
                                .enumerate()
                            {
                                let content = &inner.as_str()[1..inner.as_str().len() - 1];
                                if i >= widths.array.len() {
                                    widths.array.push(content.len());
                                } else {
                                    widths.array[i] = widths.array[i].max(content.len());
                                }
                            }
                        }
                        8 => widths.init = widths.init.max(w.trim().len()),
                        10 => widths.comment = widths.comment.max(w.trim().len()),
                        _ => {}
                    }
                }
            }

            // Handle sig_list for one_decl_per_line
            if let Some(sl) = m.name("sig_list") {
                if one_decl_per_line {
                    for s in sl.as_str().split(',') {
                        let s = s.trim();
                        if !s.is_empty() {
                            widths.name = widths.name.max(s.len());
                        }
                    }
                }
            }

            lines_match.push((l, Some(m), ilvl));
        } else {
            lines_match.push((l, None, 0));
        }
    }

    // Compute sums
    for (_, widths) in len_max.iter_mut() {
        widths.bw_sum = widths.bw.iter().map(|x| x + 2).sum();
        widths.array_sum = widths.array.iter().map(|x| x + 2).sum();
        if widths.type_user_pa > widths.type_col {
            widths.type_col = widths.type_user_pa;
        }
    }

    // Second pass: generate formatted lines and calculate max line length
    let mut formatted_lines: Vec<(String, Option<String>, usize, bool)> = Vec::new(); // (line, comment, ilvl, is_decl)
    for (line, caps, ilvl) in &lines_match {
        if let Some(m) = caps {
            let widths = &len_max[ilvl];
            let mut l = indent.repeat(*ilvl);
            let tp = m.name("type").unwrap().as_str().trim();
            let is_usertype = !["logic", "wire", "reg", "bit", "int", "integer"].contains(&tp);

            let mut len_type_full = widths.type_full + 1;
            let mut len_type = widths.type_col + 1;
            let mut t = String::new();

            // param
            if let Some(p) = m.name("param") {
                t.push_str(&format!("{:<width$}", p.as_str(), width = widths.param + 1));
                len_type_full += widths.param + 1;
            } else if widths.param != 0 {
                len_type += widths.param + 1;
            }

            if is_usertype {
                if let Some(scope) = m.name("scope") {
                    t.push_str(&format!("{}{}", scope.as_str(), tp));
                } else {
                    t.push_str(tp);
                }
                if m.name("bw").is_some() {
                    t = format!("{:<width$}", t, width = len_type);
                    let bw_clean = Regex::new(r"\s*")
                        .unwrap()
                        .replace_all(m.name("bw").unwrap().as_str(), "");
                    let mut s = String::new();
                    for (i, inner) in Regex::new(r"\[(.+?)\]")
                        .unwrap()
                        .find_iter(&bw_clean)
                        .enumerate()
                    {
                        let content = &inner.as_str()[1..inner.as_str().len() - 1];
                        let w = widths.bw.get(i).unwrap_or(&0);
                        s.push_str(&format!("[{:>width$}]", content, width = w));
                    }
                    t.push_str(&format!("{:<width$}", s, width = widths.bw_sum + 1));
                }
            } else {
                t.push_str(&format!("{:<width$}", tp, width = len_type));
                if widths.sign > 0 {
                    if let Some(sign) = m.name("sign") {
                        t.push_str(&format!(
                            "{:<width$}",
                            sign.as_str(),
                            width = widths.sign + 1
                        ));
                    } else {
                        t.push_str(&format!("{:width$}", "", width = widths.sign + 1));
                    }
                }
                if widths.bw_sum > 0 {
                    let s = if let Some(bw) = m.name("bw") {
                        let bw_clean = Regex::new(r"\s*").unwrap().replace_all(bw.as_str(), "");
                        let mut s = String::new();
                        for (i, inner) in Regex::new(r"\[(.+?)\]")
                            .unwrap()
                            .find_iter(&bw_clean)
                            .enumerate()
                        {
                            let content = &inner.as_str()[1..inner.as_str().len() - 1];
                            let w = widths.bw.get(i).unwrap_or(&0);
                            s.push_str(&format!("[{:>width$}]", content, width = w));
                        }
                        s
                    } else {
                        String::new()
                    };
                    t.push_str(&format!("{:<width$}", s, width = widths.bw_sum + 1));
                }
            }

            l.push_str(&format!("{:<width$}", t, width = len_type_full));
            let d = l.clone(); // save for signal list repetition

            if let Some(sl) = m.name("sig_list") {
                // Signal list
                l.push_str(m.name("name").unwrap().as_str());
                if let Some(arr) = m.name("array") {
                    l.push_str(&Regex::new(r"\s*").unwrap().replace_all(arr.as_str(), ""));
                }
                if let Some(init) = m.name("init") {
                    l.push_str(&format!(
                        " = {:<width$}",
                        init.as_str().trim(),
                        width = widths.init
                    ));
                }
                if one_decl_per_line {
                    for s in sl.as_str().split(',') {
                        let s = s.trim();
                        if !s.is_empty() {
                            if options.align_comma() {
                                l.push_str(&format!(";\n{}{:<width$}", d, s, width = widths.name));
                            } else {
                                l.push_str(&format!(";\n{}{}", d, s));
                            }
                        }
                    }
                } else {
                    l.push_str(sl.as_str().trim());
                }
            } else {
                l.push_str(&format!(
                    "{:<width$}",
                    m.name("name").unwrap().as_str(),
                    width = widths.name
                ));
                if widths.array_sum > 0 {
                    let s = if let Some(arr) = m.name("array") {
                        let arr_clean = Regex::new(r"\s*").unwrap().replace_all(arr.as_str(), "");
                        let mut s = String::new();
                        for (i, inner) in Regex::new(r"\[(.+?)\]")
                            .unwrap()
                            .find_iter(&arr_clean)
                            .enumerate()
                        {
                            let content = &inner.as_str()[1..inner.as_str().len() - 1];
                            let w = widths.array.get(i).unwrap_or(&0);
                            s.push_str(&format!("[{:>width$}]", content, width = w));
                        }
                        s
                    } else {
                        String::new()
                    };
                    l.push_str(&format!("{:<width$}", s, width = widths.array_sum));
                }
                if widths.init > 0 {
                    if let Some(init) = m.name("init") {
                        l.push_str(&format!(
                            " = {:<width$}",
                            init.as_str().trim(),
                            width = widths.init
                        ));
                    } else {
                        l.push_str(&format!("{:width$}", "", width = widths.init + 3));
                    }
                }
            }

            // Get comment
            let comment = m.name("comment").map(|c| c.as_str().trim().to_string());
            formatted_lines.push((l, comment, *ilvl, true));
        } else {
            formatted_lines.push((line.to_string(), None, 0, false));
        }
    }

    // Calculate max line length per indent level for semicolon alignment
    if options.align_comma() {
        for (l, _comment, ilvl, is_decl) in &formatted_lines {
            if *is_decl {
                let widths = len_max.get_mut(ilvl).unwrap();
                let line_len = l.trim_end().len();
                if line_len > widths.semi_col {
                    widths.semi_col = line_len;
                }
            }
        }
    }

    // Third pass: add semicolons and comments
    let mut txt_new = String::new();
    for (l, comment, ilvl, is_decl) in &formatted_lines {
        let l = if *is_decl {
            let widths = &len_max[ilvl];
            let mut l = l.clone();

            if options.align_comma() {
                // Align semicolon to max column
                let l_tmp = l.trim_end();
                let pad = widths.semi_col.saturating_sub(l_tmp.len());
                l = format!("{}{:width$};", l_tmp, "", width = pad);
            } else {
                let l_tmp = l.trim_end().to_string();
                let nb_pad = l.len() - l_tmp.len();
                l = format!("{};{:width$}", l_tmp, "", width = nb_pad);
            }

            if let Some(c) = comment {
                if !c.is_empty() {
                    l.push_str(&format!(" {}", c));
                }
            }
            l
        } else {
            l.clone()
        };

        txt_new.push_str(&l);
        txt_new.push('\n');
    }

    if !txt.ends_with('\n') {
        txt_new.pop(); // remove trailing newline
    }
    txt_new
}

use std::collections::HashMap;

fn get_indent_level(
    line: &str,
    options: &FormatOptions,
    indent: &str,
    indent_space: &str,
) -> usize {
    let line = if options.use_tab() {
        line.replace(indent_space, "\t")
    } else {
        line.replace('\t', indent_space)
    };
    let cnt = line.len() - line.trim_start().len();
    if options.use_tab() {
        cnt
    } else {
        cnt / options.nb_space()
    }
}

struct DeclWidths {
    param: usize,
    scope: usize,
    type_col: usize,
    type_full: usize,
    type_user: usize,
    type_user_pa: usize,
    sign: usize,
    bw: Vec<usize>,
    bw_sum: usize,
    name: usize,
    array: Vec<usize>,
    array_sum: usize,
    init: usize,
    comment: usize,
    semi_col: usize, // Position for semicolon alignment
}

impl DeclWidths {
    fn new() -> Self {
        Self {
            param: 0,
            scope: 0,
            type_col: 0,
            type_full: 0,
            type_user: 0,
            type_user_pa: 0,
            sign: 0,
            bw: Vec::new(),
            bw_sum: 0,
            name: 0,
            array: Vec::new(),
            array_sum: 0,
            init: 0,
            comment: 0,
            semi_col: 0,
        }
    }
}
