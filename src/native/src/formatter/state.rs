//! 结构和词法上下文；关闭关系由枚举定义，布局模块不猜测字符串状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum ContextKind {
    #[default]
    Code,
    IgnoreLine,
    Attribute,
    Parenthesis,
    Brace,
    Begin,
    Module,
    Class,
    Interface,
    Program,
    Function,
    Task,
    Package,
    Case,
    Generate,
    Covergroup,
    Property,
    Sequence,
    Checker,
    Fork,
    Clocking,
    Ifdef,
    Ifndef,
    Elsif,
    ElseDirective,
}
impl ContextKind {
    pub(super) fn from_keyword(word: &str) -> Option<Self> {
        Some(match word {
            "(" => Self::Parenthesis,
            "{" => Self::Brace,
            "begin" => Self::Begin,
            "module" => Self::Module,
            "class" => Self::Class,
            "interface" => Self::Interface,
            "program" => Self::Program,
            "function" => Self::Function,
            "task" => Self::Task,
            "package" => Self::Package,
            "case" => Self::Case,
            "generate" => Self::Generate,
            "covergroup" => Self::Covergroup,
            "property" => Self::Property,
            "sequence" => Self::Sequence,
            "checker" => Self::Checker,
            "fork" => Self::Fork,
            "clocking" => Self::Clocking,
            "`ifdef" => Self::Ifdef,
            "`ifndef" => Self::Ifndef,
            "`elsif" => Self::Elsif,
            "`else" => Self::ElseDirective,
            "casex" | "casez" => Self::Case,
            _ => return None,
        })
    }
    pub(super) fn is_directive(self) -> bool {
        matches!(
            self,
            Self::Ifdef | Self::Ifndef | Self::Elsif | Self::ElseDirective
        )
    }
    pub(super) fn closes_with(self, word: &str) -> bool {
        match self {
            Self::Begin => word == "end",
            Self::Module => word == "endmodule",
            Self::Class => word == "endclass",
            Self::Interface => word == "endinterface",
            Self::Program => word == "endprogram",
            Self::Function => word == "endfunction",
            Self::Task => word == "endtask",
            Self::Package => word == "endpackage",
            Self::Case => word == "endcase",
            Self::Generate => word == "endgenerate",
            Self::Covergroup => word == "endgroup",
            Self::Property => word == "endproperty",
            Self::Sequence => word == "endsequence",
            Self::Checker => word == "endchecker",
            Self::Clocking => word == "endclocking",
            Self::Brace => word == "}",
            Self::Parenthesis => word == ")",
            Self::Fork => matches!(word, "join" | "join_any" | "join_none"),
            state if state.is_directive() => matches!(word, "`elsif" | "`else" | "`endif"),
            _ => false,
        }
    }
}
#[derive(Default)]
pub(super) struct ContextStack(Vec<ContextKind>);
impl ContextStack {
    pub(super) fn current(&self) -> ContextKind {
        self.0.last().copied().unwrap_or_default()
    }
    pub(super) fn update(&mut self, next: Option<ContextKind>) {
        if let Some(next) = next {
            self.0.push(next);
        } else {
            self.0.pop();
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WordAction {
    Stay,
    Indent,
    IndentAndFlush,
}
impl WordAction {
    pub(super) fn increases_indent(self) -> bool {
        self != Self::Stay
    }
}
#[derive(Debug, Clone, PartialEq)]
pub(super) enum BlockState {
    None,
    Text,
    Decl,
    Module,
    Interface,
    Instance,
    Struct,
    StructAssign,
    Enum,
    Assign,
    Always { always_state: AlwaysState },
    Package,
    Generate,
    TaskFuncDecl,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum AlwaysState {
    None,
    If,
    ExpectElse,
    Else,
}

impl BlockState {
    pub fn is_none(&self) -> bool {
        matches!(self, BlockState::None)
    }
}
