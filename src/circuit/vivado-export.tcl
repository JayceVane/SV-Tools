# 真实 Vivado 对象导出。首版为平面 RTL 详细化视图，保留叶单元完整实例路径。
namespace eval svtools_circuit {
    variable MAX_CELLS 20000
    variable MAX_NETS 200000
    variable MAX_PINS 200000

    proc jsonString {text} {
        set result {"}
        foreach character [split $text {}] {
            scan $character %c code
            switch -- $code {
                34 {append result {\"}}
                92 {append result {\\}}
                default {
                    if {$code < 32} { append result [format {\u%04x} $code] } else { append result $character }
                }
            }
        }
        append result {"}
        return $result
    }

    # 输入是已查询得到的对象。引脚/顶层端口用 -of_objects，net 本身用位置参数。
    proc canonicalNet {object isNet} {
        if {$isNet} {
            set nets [get_nets -quiet -segments -top_net_of_hierarchical_group $object]
        } else {
            set nets [get_nets -quiet -segments -top_net_of_hierarchical_group -of_objects $object]
        }
        if {[llength $nets] > 1} { error "多个独立 net 连接到同一位对象：$object" }
        if {![llength $nets]} { return null }
        return [jsonString [get_property NAME [lindex $nets 0]]]
    }

    proc bitRecord {object name isNet} {
        set result "\{\"name\":[jsonString $name],\"net\":[canonicalNet $object $isNet]"
        if {!$isNet} { append result ",\"direction\":[jsonString [get_property DIRECTION $object]]" }
        set busName [get_property -quiet BUS_NAME $object]
        if {$busName ne {}} {
            set left [get_property BUS_START $object]
            set right [get_property BUS_STOP $object]
            if {![string is integer -strict $left] || ![string is integer -strict $right] || ![regexp {\[(-?[0-9]+)\]$} $name ignored index]} {
                error "不能完整读取总线位索引：$name"
            }
            # BUS_NAME 不含实例前缀；从实际位对象名字只移除最后一个索引。
            set qualifiedBus [string range $name 0 [expr {[string length $name] - [string length $index] - 3}]]
            append result ",\"busName\":[jsonString $qualifiedBus],\"left\":$left,\"right\":$right,\"index\":$index"
        }
        append result "\}"
        return $result
    }

    proc exportProject {projectPath outputPath} {
        variable MAX_CELLS
        variable MAX_NETS
        variable MAX_PINS
        open_project -read_only $projectPath
        # -rtl 明确请求详细化，不打开旧 synth_1，也不启动综合/实现 run。
        synth_design -rtl -name svtools_circuit_rtl
        set top [get_property TOP [current_fileset]]
        set cells [get_cells -quiet -hierarchical -filter {IS_PRIMITIVE == 1 || IS_BLACKBOX == 1}]
        set nets [get_nets -quiet -hierarchical]
        set ports [get_ports -quiet]
        if {[llength $cells] > $MAX_CELLS || [llength $nets] > $MAX_NETS || [llength $ports] > $MAX_PINS} {
            error "电路超过导出预算（单元 $MAX_CELLS，网络 $MAX_NETS，引脚 $MAX_PINS），请选择更小的顶层"
        }
        set temporaryPath "$outputPath.partial"
        set channel [open $temporaryPath w]
        fconfigure $channel -encoding utf-8 -translation lf
        if {[catch {
            puts -nonewline $channel "\{\"schemaVersion\":1,\"engine\":\"vivado\",\"version\":[jsonString [version -short]],\"stage\":\"elaborated-rtl\",\"view\":\"flat\",\"top\":[jsonString $top],\"ports\":\["
            set separator {}
            foreach port $ports {
                puts -nonewline $channel "$separator[bitRecord $port [get_property NAME $port] 0]"
                set separator ,
            }
            puts -nonewline $channel {],"cells":[}
            set separator {}
            set pinCount [llength $ports]
            foreach cell $cells {
                set pins [get_pins -quiet -of_objects $cell]
                incr pinCount [llength $pins]
                if {$pinCount > $MAX_PINS} { error "电路引脚超过导出预算 $MAX_PINS" }
                set name [get_property NAME $cell]
                set type [get_property REF_NAME $cell]
                set sequential [get_property IS_SEQUENTIAL $cell]
                set blackbox [get_property IS_BLACKBOX $cell]
                puts -nonewline $channel "$separator\{\"name\":[jsonString $name],\"type\":[jsonString $type],\"isSequential\":[expr {$sequential ? {true} : {false}}],\"isBlackbox\":[expr {$blackbox ? {true} : {false}}]"
                set sourceFile [get_property -quiet FILE_NAME $cell]
                set sourceLine [get_property -quiet LINE_NUMBER $cell]
                if {$sourceFile ne {} && [string is integer -strict $sourceLine] && $sourceLine > 0} {
                    puts -nonewline $channel ",\"source\":\{\"path\":[jsonString $sourceFile],\"line\":$sourceLine,\"column\":1\}"
                }
                puts -nonewline $channel {,"ports":[}
                set pinSeparator {}
                foreach pin $pins {
                    puts -nonewline $channel "$pinSeparator[bitRecord $pin [get_property REF_PIN_NAME $pin] 0]"
                    set pinSeparator ,
                }
                puts -nonewline $channel "\]\}"
                set separator ,
            }
            puts -nonewline $channel {],"signals":[}
            set separator {}
            foreach net $nets {
                puts -nonewline $channel "$separator[bitRecord $net [get_property NAME $net] 1]"
                set separator ,
            }
            puts $channel "\]\}"
        } errorMessage]} {
            close $channel
            error $errorMessage
        }
        close $channel
        close_project
        file rename -force $temporaryPath $outputPath
    }
}
