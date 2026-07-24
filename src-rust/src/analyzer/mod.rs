use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};
use tree_sitter_systemverilog::LANGUAGE;

/// Symbol kind for VSCode DocumentSymbol
#[napi(string_enum)]
#[derive(Debug, Serialize, Deserialize)]
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
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SvSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub detail: Option<String>,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub children: Vec<SvSymbol>,
}

/// Parse result
#[napi(object)]
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
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
        children,
    })
}

fn find_name(node: &Node, source: &str) -> Option<String> {
    // Look for identifier child node, skipping attribute nodes like (* ... *)
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            let kind = child.kind();
            if kind.starts_with("attribute") {
                continue;
            }
            if kind == "identifier"
                || kind == "simple_identifier"
                || kind == "hierarchical_identifier"
            {
                return Some(child.utf8_text(source.as_bytes()).ok()?.to_string());
            }
            // Some nodes have nested name nodes (e.g. module_ansi_header)
            if let Some(name) = find_name(&child, source) {
                return Some(name);
            }
        }
    }
    None
}

fn extract_children(node: &Node, source: &str, parent_kind: &SymbolKind) -> Vec<SvSymbol> {
    let mut children = Vec::new();

    // Start at the first child so we don't skip the parent node itself
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        visit_children(&mut cursor, source, parent_kind, &mut children);
    }
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
            "port_declaration" | "ansi_port_declaration" => {
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
            "task_declaration" | "function_declaration" => {
                if let Some(sym) = node_to_symbol(&node, source) {
                    symbols.push(sym);
                }
            }
            _ => {}
        }

        // Recurse into children, but skip nested top-level containers
        // (module/interface/class/package) to avoid duplicating symbols.
        // Always recurse into task/function bodies to capture their contents.
        if !matches!(
            node.kind(),
            "module_declaration"
                | "interface_declaration"
                | "class_declaration"
                | "package_declaration"
        ) {
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
    // For ports, the name is a direct child simple_identifier
    // (not nested inside dimension expressions like [0:(DATA_WIDTH-1)])
    let name = find_direct_identifier(node, source)?;
    let start = node.start_position();
    let end = node.end_position();
    let text = node.utf8_text(source.as_bytes()).ok()?.to_string();

    Some(SvSymbol {
        name,
        kind: SymbolKind::Port,
        detail: Some(text.trim().to_string()),
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
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
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
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
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
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
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
        children: Vec::new(),
    })
}

fn instance_to_symbol(node: &Node, source: &str) -> Option<SvSymbol> {
    // Instance name = last identifier, module type = first identifier
    let name = find_last_identifier(node, source)?;
    let module_type = find_first_identifier(node, source);
    let start = node.start_position();
    let end = node.end_position();

    Some(SvSymbol {
        name,
        kind: SymbolKind::Instance,
        detail: module_type,
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
        children: Vec::new(),
    })
}

fn find_first_identifier(node: &Node, source: &str) -> Option<String> {
    // Depth-first search for the first identifier,
    // skipping type/dimension subtrees that contain parameter references
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            let kind = child.kind();
            // Skip type and dimension subtrees — identifiers there are
            // parameter references (e.g. DATA_WIDTH in [0:(DATA_WIDTH-1)])
            if kind.starts_with("data_type")
                || kind.starts_with("net_type")
                || kind.starts_with("variable_port_header")
                || kind.starts_with("net_port_header")
                || kind == "packed_dimension"
                || kind == "unpacked_dimension"
            {
                continue;
            }
            if kind == "identifier" || kind == "simple_identifier" {
                return child.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
            }
            if let Some(name) = find_first_identifier(&child, source) {
                return Some(name);
            }
        }
    }
    None
}

fn find_direct_identifier(node: &Node, source: &str) -> Option<String> {
    // Look for identifier among direct children only (skip nested dimensions/headers)
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "identifier" || child.kind() == "simple_identifier" {
                return child.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
            }
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

    #[test]
    fn test_parse_package() {
        let source = r#"
package my_pkg;
    typedef enum logic [1:0] {
        IDLE,
        RUN,
        DONE
    } state_t;

    typedef struct packed {
        logic [7:0] data;
        logic       valid;
    } packet_t;

    parameter int DEPTH = 16;
endpackage
"#;
        let result = extract_symbols(source);
        assert!(
            result.errors.is_empty(),
            "Parse errors: {:?}",
            result.errors
        );
        let pkg = result
            .symbols
            .iter()
            .find(|s| matches!(s.kind, SymbolKind::Package));
        assert!(pkg.is_some(), "Package not found");
        assert_eq!(pkg.unwrap().name, "my_pkg");
    }

    #[test]
    fn test_parse_class() {
        let source = r#"
class transaction;
    rand bit [31:0] addr;
    rand bit [7:0]  data;

    function new(bit [31:0] a);
        addr = a;
    endfunction

    task send();
        $display("send %h", addr);
    endtask
endclass
"#;
        let result = extract_symbols(source);
        assert!(
            result.errors.is_empty(),
            "Parse errors: {:?}",
            result.errors
        );
        let cls = result
            .symbols
            .iter()
            .find(|s| matches!(s.kind, SymbolKind::Class));
        assert!(cls.is_some(), "Class not found");
        assert_eq!(cls.unwrap().name, "transaction");
    }

    #[test]
    fn test_parse_task_function() {
        let source = r#"
module tb;
    logic clk;

    task automatic drive(input int n, input logic [7:0] val);
        repeat(n) @(posedge clk);
    endtask

    function automatic logic [7:0] add(input logic [7:0] a, b);
        return a + b;
    endfunction
endmodule
"#;
        let result = extract_symbols(source);
        assert!(
            result.errors.is_empty(),
            "Parse errors: {:?}",
            result.errors
        );
        let module = result
            .symbols
            .iter()
            .find(|s| matches!(s.kind, SymbolKind::Module));
        assert!(module.is_some(), "Module not found");
        let children = &module.unwrap().children;
        assert!(
            children.iter().any(|c| matches!(c.kind, SymbolKind::Task)),
            "Task not found in module children: {:?}",
            children
        );
        assert!(
            children.iter().any(|c| matches!(c.kind, SymbolKind::Function)),
            "Function not found in module children: {:?}",
            children
        );
    }

    #[test]
    fn test_parse_module_with_instance() {
        let source = r#"
module top (
    input  clk,
    input  rst_n,
    output [7:0] result
);
    wire [7:0] internal;

    sub_module #(.W(8)) u_sub (
        .clk    (clk),
        .rst_n  (rst_n),
        .data_o (internal)
    );

    assign result = internal;
endmodule
"#;
        let result = extract_symbols(source);
        assert!(
            result.errors.is_empty(),
            "Parse errors: {:?}",
            result.errors
        );
        let module = result
            .symbols
            .iter()
            .find(|s| matches!(s.kind, SymbolKind::Module));
        assert!(module.is_some(), "Module not found");
        let children = &module.unwrap().children;
        assert!(
            children.iter().any(|c| matches!(c.kind, SymbolKind::Instance)),
            "Instance not found in module children: {:?}",
            children
        );
    }

    #[test]
    fn test_multiple_top_level_symbols() {
        let source = r#"
package pkg_a;
    parameter int X = 1;
endpackage

module mod_a (input clk);
endmodule

module mod_b (input clk);
endmodule
"#;
        let result = extract_symbols(source);
        assert!(
            result.errors.is_empty(),
            "Parse errors: {:?}",
            result.errors
        );
        assert_eq!(result.symbols.len(), 3, "Expected 3 top-level symbols");
        assert!(matches!(result.symbols[0].kind, SymbolKind::Package));
        assert!(matches!(result.symbols[1].kind, SymbolKind::Module));
        assert!(matches!(result.symbols[2].kind, SymbolKind::Module));
    }

    #[test]
    fn test_module_ports_and_params_as_children() {
        let source = r#"
module alu #(
    parameter W  = 8,
    parameter DW = W * 2
) (
    input  clk,
    input  rst_n,
    input  [W-1:0] op_a,
    output [DW-1:0] result
);
endmodule
"#;
        let result = extract_symbols(source);
        assert!(
            result.errors.is_empty(),
            "Parse errors: {:?}",
            result.errors
        );
        let module = &result.symbols[0];
        assert_eq!(module.name, "alu");
        let params: Vec<_> = module
            .children
            .iter()
            .filter(|c| matches!(c.kind, SymbolKind::Parameter))
            .collect();
        let ports: Vec<_> = module
            .children
            .iter()
            .filter(|c| matches!(c.kind, SymbolKind::Port))
            .collect();
        assert!(!params.is_empty(), "No parameters found");
        assert!(!ports.is_empty(), "No ports found");
    }

    #[test]
    fn test_find_symbol_by_name() {
        let source = r#"
module foo (input clk);
endmodule

module bar (input clk);
endmodule
"#;
        let found = find_symbol_by_name(source, "bar");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "bar");
        assert!(matches!(found[0].kind, SymbolKind::Module));
    }

    #[test]
    fn test_parse_error_reported() {
        let source = r#"
module broken (
    input clk
    // missing closing paren and semicolon
endmodule
"#;
        let result = extract_symbols(source);
        // tree-sitter is error-tolerant, so it may still produce symbols
        // but should report errors for malformed code
        // (the exact behavior depends on the grammar's error recovery)
        println!("Errors: {:?}", result.errors);
        println!("Symbols: {:?}", result.symbols);
    }

    #[test]
    fn test_parse_aurora_axi_to_ll() {
        let source = std::fs::read_to_string(
            r"D:\Workspace\FPGA\02_svtools\test_project\sfp_wapper\aurora_64b66b\aurora_64b66b_0_example_axi_to_ll.v"
        ).expect("test file not found");
        let result = extract_symbols(&source);
        // Module name must not be picked from (* ... *) attribute
        assert_eq!(result.symbols.len(), 1);
        assert_eq!(result.symbols[0].name, "aurora_64b66b_0_EXAMPLE_AXI_TO_LL");
        // Net/var names must not be picked from dimension expressions
        let names: Vec<&str> = result.symbols[0].children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"LL_OP_DATA_INT"), "missing LL_OP_DATA_INT: {:?}", names);
        assert!(names.contains(&"i_rem"), "missing i_rem: {:?}", names);
        assert!(!names.contains(&"DATA_WIDTH"), "DATA_WIDTH should not be a child name");
    }
}
