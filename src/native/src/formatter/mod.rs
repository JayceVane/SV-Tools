//! 格式化编排；状态识别、行布局、块对齐和输出提交各有单独处理器。
use crate::align::assign::AssignmentKind;
use crate::config::FormatOptions;
use crate::parser::comments::clean_comment;
use crate::parser::patterns::*;
use crate::tokenizer::Token;
use regex::Regex;
use std::collections::HashMap;
mod blocks;
mod instances;
mod layout;
mod procedural;
mod protected;
mod session;
mod state;
mod structure;
use session::*;
use state::*;

/// 与编辑器和 CLI 共享的文本布局器；每次调用建立独立的状态会话。
pub struct VerilogBeautifier {
    options: FormatOptions,
}
impl VerilogBeautifier {
    pub fn new(options: FormatOptions) -> Self {
        Self { options }
    }
    /// 兼容入口也执行字符保全，未知语法或异常不得破坏非布局字符。
    pub fn beautify_text(&mut self, text: &str) -> String {
        let options = self.options.clone();
        crate::format_guard::format(text, || Engine::new(options).format(text))
    }
}
struct Engine {
    options: FormatOptions,
    indent: String,
    indent_space: String,
    syntax: ContextStack,
    block_state: BlockState,
}
impl Engine {
    fn new(options: FormatOptions) -> Self {
        let indent_space = " ".repeat(options.nb_space());
        let indent = if options.use_tab() {
            "\t".to_string()
        } else {
            indent_space.clone()
        };
        Self {
            options,
            indent,
            indent_space,
            syntax: ContextStack::default(),
            block_state: BlockState::None,
        }
    }
    fn format(&mut self, text: &str) -> String {
        let level = Self::get_indent_level(text, &self.options, &self.indent, &self.indent_space);
        let mut session = FormatSession::new(level);
        for token in crate::tokenizer::tokenize(text) {
            // 标点借用栈上 UTF-8 缓冲，不延长分配生命周期。
            let mut punct = [0u8; 4];
            let word = match &token {
                Token::Word(value) | Token::Space(value) => value.as_str(),
                Token::Punct(value) => value.encode_utf8(&mut punct),
                Token::Newline => "\n",
                Token::Protected { kind, text } => {
                    self.emit_protected(&mut session, *kind, text);
                    continue;
                }
            };
            let state_end = self.syntax.current().closes_with(word);
            self.update_else_continuation(&mut session, word);
            if session.history.last() == "\n" {
                self.prepare_line(&mut session, word, state_end);
            }
            self.finish_continuation(&mut session, word);
            self.emit_token(&mut session, word, state_end);
            if self.handle_semicolon(&mut session, word) {
                continue;
            }
            self.handle_close(&mut session, word, state_end);
            self.handle_attribute(&mut session, word, state_end);
            self.handle_always(&mut session, word, state_end);
            self.commit_block(&mut session, word);
            if !word.trim().is_empty() || session.history.last() != "\n" {
                session.history.push(word);
            }
        }
        self.finish_file(&mut session)
    }
}

/// assign 块的最后一条非空代码行（去注释）。悬空运算符判定不能用
/// lines().last()：块尾已积累空行时会取到空串使守卫失效，语句被错误切断
/// （多行拼接/破行链条中有空行时一次与二次格式化分段不同 → 幂等破坏）。
fn last_nonempty_line(block: &str) -> String {
    clean_comment(block)
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim_end().to_string())
        .unwrap_or_default()
}

/// assign 块内 `{`/`(` 括号深度是否大于 0（多行拼接/破行表达式跨行未完）。
/// 闭合行（`} ;`）独占一行时，行首 state_end 会先弹出 "{" 状态，单靠
/// state 判定会漏判，须按共享词法扫描得到的代码括号深度兜底。
fn assign_block_unbalanced(block: &str) -> bool {
    let code = crate::source_scan::mask_non_code(block);
    let mut depth_paren = 0i32;
    let mut depth_brace = 0i32;
    for c in code.chars() {
        match c {
            '(' => depth_paren += 1,
            ')' => depth_paren -= 1,
            '{' => depth_brace += 1,
            '}' => depth_brace -= 1,
            _ => {}
        }
    }
    depth_paren > 0 || depth_brace > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_attribute_state_management() {
        let options = FormatOptions::default();
        let mut beautifier = VerilogBeautifier::new(options);

        // Test that (* ... *) attribute doesn't leave residual "(" state
        let input = r#"(* mark_debug = "true" *) reg [31:0] dbg_rfu_wreg0;"#;
        let result = beautifier.beautify_text(input);
        println!("Input: {}", input);
        println!("Output: {}", result);

        assert_eq!(
            result,
            beautifier.beautify_text(input),
            "格式化请求不能共享上次调用的语法状态"
        );
    }

    #[test]
    fn test_attribute_in_if_block() {
        let options = FormatOptions::default();
        let mut beautifier = VerilogBeautifier::new(options);

        let input = r#"if(DEBUG_EN) begin
    (* mark_debug = "true" *) reg [31:0] dbg_rfu_wreg0   ;
    (* mark_debug = "true" *) reg [31:0] dbg_rfu_wreg1   ;
    (* mark_debug = "true" *) reg        dbg_tx_done_reg ;
end"#;

        let result = beautifier.beautify_text(input);
        println!("Input:\n{}", input);
        println!("\nOutput:\n{}", result);

        // Verify output is valid and doesn't corrupt subsequent processing
        assert!(
            result.contains("mark_debug"),
            "Attribute should be preserved"
        );
        assert!(result.contains("reg"), "reg keyword should be preserved");

        // Check semicolon alignment - all semicolons should be at the same column
        let lines: Vec<&str> = result.lines().collect();
        let reg_lines: Vec<&str> = lines
            .iter()
            .filter(|l| l.contains("reg") && l.contains("dbg_"))
            .copied()
            .collect();

        assert_eq!(reg_lines.len(), 3, "Expected 3 reg declarations");

        // Find position of semicolons
        let semi_positions: Vec<usize> = reg_lines
            .iter()
            .map(|l| l.rfind(';').unwrap_or(0))
            .collect();

        println!("Semicolon positions: {:?}", semi_positions);

        // All semicolons should be at the same position
        let first_pos = semi_positions[0];
        for (i, pos) in semi_positions.iter().enumerate() {
            assert_eq!(
                *pos, first_pos,
                "Semicolon at line {} is not aligned. Expected position {}, got {}",
                i, first_pos, pos
            );
        }
    }

    #[test]
    fn test_if_block_without_attribute() {
        // Test case from test5.sv line 360-385
        // 走真实管线（preprocess→beautify→blank 规则），与 formatText 一致；
        // 直接调 beautify_text 会绕过 preprocess，输入残留的手工空格不被清理
        let input = r#"if(DEBUG_ENABLE) begin
    reg [31:0] dbg_User_Reg_awwaddr ;
    reg [31:0] dbg_User_Reg_awwdata ;
    reg        dbg_User_Reg_awwvalid;
    reg        dbg_User_Reg_awready;
    reg [31:0] dbg_User_Reg_araddr  ;
    reg        dbg_User_Reg_arvalid ;
    reg        dbg_User_Reg_arready ;
    reg [31:0] dbg_User_Reg_rdata   ;
    reg        dbg_User_Reg_rready  ;
    reg        dbg_User_Reg_rvalid  ;

    always @(posedge gp_clk) begin
        dbg_User_Reg_awwaddr  <= User_Reg_awwaddr ;
        dbg_User_Reg_awwdata  <= User_Reg_awwdata ;
        dbg_User_Reg_awwvalid <= User_Reg_awwvalid ;
        dbg_User_Reg_awwready <= User_Reg_awwready ;
        dbg_User_Reg_araddr   <= User_Reg_araddr ;
        dbg_User_Reg_arvalid  <= User_Reg_arvalid ;
        dbg_User_Reg_arready  <= User_Reg_arready   ;
        dbg_User_Reg_rdata    <= User_Reg_rdata ;
        dbg_User_Reg_rready   <= User_Reg_rready ;
        dbg_User_Reg_rvalid   <= User_Reg_rvalid ;
    end
end"#;

        let result = crate::format_code_segment(input, &FormatOptions::default());
        println!("Input:\n{}", input);
        println!("\nOutput:\n{}", result);

        // Check reg declarations are aligned
        let lines: Vec<&str> = result.lines().collect();
        let reg_decl_lines: Vec<&str> = lines
            .iter()
            .filter(|l| l.trim().starts_with("reg") && l.contains("dbg_User"))
            .copied()
            .collect();

        println!("Reg declaration lines: {:?}", reg_decl_lines.len());

        // Check always block assignments are aligned
        let always_lines: Vec<&str> = lines
            .iter()
            .filter(|l| l.contains("<=") && l.contains("dbg_User"))
            .copied()
            .collect();

        println!("Always assignment lines: {:?}", always_lines.len());

        // 分号贴合表达式（无悬挂空格）；<= 运算符列对齐仍应成立。
        // 曾经对 always 块做同缩进组分号悬挂对齐，已按用户语义移除
        // （语句不是表格；声明区的表格化悬挂不受影响）
        for (i, l) in always_lines.iter().enumerate() {
            let t = l.trim_end();
            assert!(t.ends_with(';'), "always 行 {} 不以分号结尾: {:?}", i, l);
            let before_semi = &t[..t.len() - 1];
            assert_eq!(
                before_semi,
                before_semi.trim_end(),
                "always 行 {} 分号前有悬挂空格: {:?}",
                i,
                l
            );
        }

        let op_pos: Vec<usize> = always_lines
            .iter()
            .map(|l| l.find("<=").unwrap_or(0))
            .collect();
        if !op_pos.is_empty() {
            let first = op_pos[0];
            for (i, &pos) in op_pos.iter().enumerate() {
                assert_eq!(
                    pos, first,
                    "<= at always block line {} not aligned. Expected {}, got {}",
                    i, first, pos
                );
            }
        }
    }

    #[test]
    fn test_rfind_standalone_end() {
        assert_eq!(Engine::rfind_standalone_end("end"), Some(0));
        assert_eq!(Engine::rfind_standalone_end("  end  "), Some(2));
        assert_eq!(Engine::rfind_standalone_end("endmodule"), None);
        assert_eq!(Engine::rfind_standalone_end("endtask"), None);
        assert_eq!(Engine::rfind_standalone_end("endfunction"), None);
        assert_eq!(Engine::rfind_standalone_end("end\nendmodule"), Some(0));
        assert_eq!(Engine::rfind_standalone_end("data <= 1;\nend"), Some(11));
        assert_eq!(
            Engine::rfind_standalone_end("end\nendmodule\nend"),
            Some(14)
        );
        assert_eq!(Engine::rfind_standalone_end("no_keyword"), None);
        assert_eq!(Engine::rfind_standalone_end("backend"), None);
    }

    #[test]
    fn test_always_if_begin_end_no_else() {
        let options = FormatOptions::default();
        let mut beautifier = VerilogBeautifier::new(options);

        let input = r#"module test (
    input  clk,
    input  rst,
    output reg data
);

    always @(posedge clk)
        if (rst) begin
            data <= 1'b0;
        end

    assign x = 1;

endmodule
"#;
        let result = beautifier.beautify_text(input);

        assert!(
            result.contains("endmodule"),
            "endmodule should not be split: {}",
            result
        );
        assert!(
            !result.contains("end\n\nmodule"),
            "endmodule must not be split into end + module: {}",
            result
        );

        let lines: Vec<&str> = result.lines().collect();
        let assign_line = lines.iter().find(|l| l.trim().starts_with("assign x"));
        if let Some(l) = assign_line {
            let indent = l.len() - l.trim_start().len();
            assert_eq!(
                indent, 4,
                "assign should be at module body indent (4 spaces), got {}: '{}'",
                indent, l
            );
        }
    }

    #[test]
    fn test_always_if_else_begin_end() {
        let options = FormatOptions::default();
        let mut beautifier = VerilogBeautifier::new(options);

        let input = r#"module test (
    input  clk,
    input  rst,
    output reg data
);

    always @(posedge clk)
        if (rst)
            data <= 1'b0;
        else if (!rst)
            data <= 1'b1;

endmodule
"#;
        let result = beautifier.beautify_text(input);

        assert!(
            result.contains("endmodule"),
            "endmodule should not be split: {}",
            result
        );
        assert!(
            !result.contains("end\n\nmodule"),
            "endmodule must not be split into end + module: {}",
            result
        );

        let endmodule_line = result.lines().find(|l| l.trim() == "endmodule");
        if let Some(l) = endmodule_line {
            let indent = l.len() - l.trim_start().len();
            assert_eq!(
                indent, 0,
                "endmodule should be at top level (0 indent), got {}: '{}'",
                indent, l
            );
        }
    }
}
