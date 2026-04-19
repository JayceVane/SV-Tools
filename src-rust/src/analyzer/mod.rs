use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser, Query, QueryCursor};
use tree_sitter_systemverilog::LANGUAGE;

/// Symbol kind for VSCode DocumentSymbol
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SymbolKind {
    Module,
    Interface,
    Package,
    Class,
    Task,
    Function,
    Parameter,
    Port,
    Variable,
    Net,
    Instance,
    Typedef,
    Enum,
    Struct,
    Property,
    Sequence,
    Covergroup,
}

/// A symbol extracted from SV source
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SvSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub detail: Option<String>,
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
    pub children: Vec<SvSymbol>,
}

/// Parse result
#[derive(Debug, Serialize, Deserialize)]
pub struct ParseResult {
    pub symbols: Vec<SvSymbol>,
    pub errors: Vec<String>,
}

/// Extract all symbols from SystemVerilog source text
pub fn extract_symbols(source: &str) -> ParseResult {
    let mut parser = Parser::new();
    parser
        .set_language(&LANGUAGE.into())
        .expect("Error loading SystemVerilog grammar");

    let tree = parser.parse(source, None).unwrap();
    let mut errors = Vec::new();

    // Collect parse errors
    collect_errors(&tree.root_node(), source, &mut errors);

    // Extract symbols
    let symbols = extract_node_symbols(&tree.root_node(), source);

    ParseResult { symbols, errors }
}

fn collect_errors(node: &Node, source: &str, errors: &mut Vec<String>) {
    if node.is_error() || node.is_missing() {
        let start = node.start_position();
        let text = &source[node.byte_range()];
        let preview: String = text.chars().take(80).collect();
        errors.push(format!(
            "Line {}: parse error near '{}'",
            start.row + 1,
            preview
        ));
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            collect_errors(&child, source, errors);
        }
    }
}

fn extract_node_symbols(node: &Node, source: &str) -> Vec<SvSymbol> {
    let mut symbols = Vec::new();

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if let Some(sym) = node_to_symbol(&child, source) {
                symbols.push(sym);
            }
        }
    }

    symbols
}

fn node_to_symbol(node: &Node, source: &str) -> Option<SvSymbol> {
    let kind = match node.kind() {
        "module_declaration" => SymbolKind::Module,
        "interface_declaration" => SymbolKind::Interface,
        "package_declaration" => SymbolKind::Package,
        "class_declaration" => SymbolKind::Class,
        "task_declaration" => SymbolKind::Task,
        "function_declaration" => SymbolKind::Function,
        "typedef_declaration" => SymbolKind::Typedef,
        "covergroup_declaration" => SymbolKind::Covergroup,
        "property_declaration" => SymbolKind::Property,
        "sequence_declaration" => SymbolKind::Sequence,
        _ => return None,
    };

    let name = find_name(node, source)?;

    let start = node.start_position();
    let end = node.end_position();

    // Extract children (ports, parameters, variables, instances)
    let children = extract_children(node, source, &kind);

    Some(SvSymbol {
        name,
        kind,
        detail: None,
        start_line: start.row + 1,
        start_col: start.column,
        end_line: end.row + 1,
        end_col: end.column,
        children,
    })
}

fn find_name(node: &Node, source: &str) -> Option<String> {
    // Look for identifier child node
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "identifier"
                || child.kind() == "simple_identifier"
                || child.kind() == "hierarchical_identifier"
            {
                return Some(child.utf8_text(source.as_bytes()).ok()?.to_string());
            }
            // Some nodes have nested name nodes
            if let Some(name) = find_name(&child, source) {
                return Some(name);
            }
        }
    }
    None
}

fn extract_children(node: &Node, source: &str, parent_kind: &SymbolKind) -> Vec<SvSymbol> {
    let mut children = Vec::new();

    // Walk all descendants looking for ports, params, declarations
    let mut cursor = node.walk();
    visit_children(&mut cursor, source, parent_kind, &mut children);
    drop(cursor);

    children
}

fn visit_children(
    cursor: &mut tree_sitter::TreeCursor,
    source: &str,
    parent_kind: &SymbolKind,
    symbols: &mut Vec<SvSymbol>,
) {
    loop {
        let node = cursor.node();

        match node.kind() {
            "port_declaration" => {
                if let Some(sym) = port_to_symbol(&node, source) {
                    symbols.push(sym);
                }
            }
            "parameter_declaration" | "local_parameter_declaration" => {
                if let Some(sym) = param_to_symbol(&node, source) {
                    symbols.push(sym);
                }
            }
            "net_declaration" => {
                if let Some(sym) = net_to_symbol(&node, source) {
                    symbols.push(sym);
                }
            }
            "data_declaration" => {
                if let Some(sym) = var_to_symbol(&node, source) {
                    symbols.push(sym);
                }
            }
            "module_instantiation" | "hierarchical_instance" => {
                if let Some(sym) = instance_to_symbol(&node, source) {
                    symbols.push(sym);
                }
            }
            _ => {}
        }

        // Recurse into children, but skip body of nested module/class/etc
        // to avoid duplicating symbols
        if !matches!(
            node.kind(),
            "module_declaration"
                | "interface_declaration"
                | "class_declaration"
                | "package_declaration"
                | "task_declaration"
                | "function_declaration"
        ) || std::mem::discriminant(parent_kind) == std::mem::discriminant(&SymbolKind::Module)
        {
            if cursor.goto_first_child() {
                visit_children(cursor, source, parent_kind, symbols);
                cursor.goto_parent();
            }
        }

        if !cursor.goto_next_sibling() {
            break;
        }
    }
}

fn port_to_symbol(node: &Node, source: &str) -> Option<SvSymbol> {
    let name = find_first_identifier(node, source)?;
    let start = node.start_position();
    let end = node.end_position();
    let text = node.utf8_text(source.as_bytes()).ok()?.to_string();

    Some(SvSymbol {
        name,
        kind: SymbolKind::Port,
        detail: Some(text.trim().to_string()),
        start_line: start.row + 1,
        start_col: start.column,
        end_line: end.row + 1,
        end_col: end.column,
        children: Vec::new(),
    })
}

fn param_to_symbol(node: &Node, source: &str) -> Option<SvSymbol> {
    let name = find_first_identifier(node, source)?;
    let start = node.start_position();
    let end = node.end_position();

    Some(SvSymbol {
        name,
        kind: SymbolKind::Parameter,
        detail: None,
        start_line: start.row + 1,
        start_col: start.column,
        end_line: end.row + 1,
        end_col: end.column,
        children: Vec::new(),
    })
}

fn net_to_symbol(node: &Node, source: &str) -> Option<SvSymbol> {
    let name = find_first_identifier(node, source)?;
    let start = node.start_position();
    let end = node.end_position();

    Some(SvSymbol {
        name,
        kind: SymbolKind::Net,
        detail: None,
        start_line: start.row + 1,
        start_col: start.column,
        end_line: end.row + 1,
        end_col: end.column,
        children: Vec::new(),
    })
}

fn var_to_symbol(node: &Node, source: &str) -> Option<SvSymbol> {
    let name = find_first_identifier(node, source)?;
    let start = node.start_position();
    let end = node.end_position();

    Some(SvSymbol {
        name,
        kind: SymbolKind::Variable,
        detail: None,
        start_line: start.row + 1,
        start_col: start.column,
        end_line: end.row + 1,
        end_col: end.column,
        children: Vec::new(),
    })
}

fn instance_to_symbol(node: &Node, source: &str) -> Option<SvSymbol> {
    // For instances, we want the instance name (not the module type)
    let name = find_last_identifier(node, source)?;
    let start = node.start_position();
    let end = node.end_position();

    Some(SvSymbol {
        name,
        kind: SymbolKind::Instance,
        detail: None,
        start_line: start.row + 1,
        start_col: start.column,
        end_line: end.row + 1,
        end_col: end.column,
        children: Vec::new(),
    })
}

fn find_first_identifier(node: &Node, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            let n = cursor.node();
            if n.kind() == "identifier" || n.kind() == "simple_identifier" {
                return n.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
            }
            if cursor.goto_next_sibling() {
                continue;
            }
            break;
        }
    }
    None
}

fn find_last_identifier(node: &Node, source: &str) -> Option<String> {
    let mut last_id = None;
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            let n = cursor.node();
            if n.kind() == "identifier" || n.kind() == "simple_identifier" {
                last_id = n.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
            }
            if cursor.goto_next_sibling() {
                continue;
            }
            break;
        }
    }
    last_id
}

/// Query symbols by name (for hover/goto definition)
pub fn find_symbol_by_name(source: &str, name: &str) -> Vec<SvSymbol> {
    let result = extract_symbols(source);
    let mut found = Vec::new();
    for sym in &result.symbols {
        search_symbol_recursive(sym, name, &mut found);
    }
    found
}

fn search_symbol_recursive(sym: &SvSymbol, name: &str, found: &mut Vec<SvSymbol>) {
    if sym.name == name {
        found.push(sym.clone());
    }
    for child in &sym.children {
        search_symbol_recursive(child, name, found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_module() {
        let source = r#"
module simple_module #(
    parameter W = 8
) (
    input clk,
    input rst_n,
    input [W-1:0] data_in,
    output reg [W-1:0] data_out
);
    always @(posedge clk) begin
        data_out <= data_in;
    end
endmodule
"#;
        let result = extract_symbols(source);
        assert!(
            result.errors.is_empty(),
            "Parse errors: {:?}",
            result.errors
        );
        assert!(!result.symbols.is_empty(), "No symbols found");
        println!("Symbols: {:#?}", result.symbols);
    }

    #[test]
    fn test_parse_interface() {
        let source = r#"
interface axi_if #(parameter W=32)();
    logic valid;
    logic ready;
    modport master(output valid, input ready);
endinterface
"#;
        let result = extract_symbols(source);
        assert!(
            result.errors.is_empty(),
            "Parse errors: {:?}",
            result.errors
        );
        assert!(result
            .symbols
            .iter()
            .any(|s| matches!(s.kind, SymbolKind::Interface)));
    }
}
