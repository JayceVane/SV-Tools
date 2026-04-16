#!/usr/bin/env python3
"""
Verilog-Gadget Core Module
Ported from Sublime Text Verilog-Gadget plugin for VSCode extension

Copyright (c) 2025 JayceVane (JayceVane@163.com)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

This is a VSCode extension adapted from the Sublime Text Verilog-Gadget plugin
by yongchan jeon (poucotm@gmail.com)
"""

import re
import os
import datetime
from typing import List, Tuple, Optional, Dict, Any


def trim_space(text: str) -> str:
    """Trim leading and trailing whitespace"""
    return re.sub(re.compile(r'^\s+|\s+$'), '', text)


def regex_search(pattern: str, text: str) -> str:
    """Search for pattern in text and return match"""
    mobj = re.compile(pattern).search(text)
    return mobj.group() if mobj else ''


def remove_comment_line_space(codes: str) -> str:
    """Remove comments and normalize whitespace for parsing"""

    def remove_comments(pattern, text):
        txts = re.compile(pattern, re.DOTALL).findall(text)
        for txt in txts:
            if isinstance(txt, str):
                blnk = '\n' * (txt.count('\n'))
                text = text.replace(txt, blnk)
            elif isinstance(txt, tuple) and txt[1]:
                blnk = '\n' * (txt[1].count('\n'))
                text = text.replace(txt[1], blnk)
        return text

    codes = re.sub(re.compile(r'//\*.*?$', re.MULTILINE), '', codes)
    codes = remove_comments(r'/\*.*?\*/', codes)
    codes = re.sub(re.compile(r'//.*?$', re.MULTILINE), '', codes)
    codes = remove_comments(r'(@\s*?\(\s*?\*\s*?\))|(\(\*.*?\*\))', codes)
    codes = re.sub(re.compile(r'\s*[\n]'), ' ', codes)
    codes = re.sub(re.compile(r';'), '; ', codes)
    codes = re.sub(re.compile(r'\['), ' [', codes)
    codes = re.sub(re.compile(r'\s+'), ' ', codes)
    return codes


def parse_param(text: str, prefix: str, param_list: List[List[str]]) -> bool:
    """Parse parameter declarations"""
    ptype = ''
    isprm = False
    try:
        for strl in text.split(','):
            p_mch = re.compile(prefix+r'(?P<type>.*?)(?P<name>\w+)\s*=(?P<value>.*)').search(strl)
            if p_mch:
                ptype = trim_space(p_mch.group('type'))
                ptype = re.sub(re.compile(r'\s{2,}'), ' ', ptype)
                pname = p_mch.group('name')
                p_val = trim_space(p_mch.group('value'))
                param_list.append([prefix, ptype, pname, p_val])
                isprm = True
            else:
                p_mch = re.compile(r'(?P<name>\w+)\s*=(?P<value>.*)').search(strl)
                if p_mch and isprm:
                    pname = p_mch.group('name')
                    p_val = trim_space(p_mch.group('value'))
                    param_list.append([prefix, ptype, pname, p_val])
    except Exception:
        return False
    return True


def parse_ports(text: str, ports_list: List[List[str]]) -> bool:
    """Parse port declarations"""
    try:
        p_dir = ''
        psize = ''
        for strl in text.split(','):
            strl = re.sub(r'=.*', '', strl)
            stra = re.sub(r'\[.*?\]', ' ', strl)
            pntmp = re.compile(r'\w+').findall(stra)
            pname = pntmp[-1] if len(pntmp) > 0 else ''
            pdtmp = regex_search(r'(?<!\S)input(?!\S)|(?<!\S)output(?!\S)|(?<!\S)inout(?!\S)', strl)
            pstmp = regex_search(r'\[.*?\]|(?<!\S)signed\s*\[.*?\]|(?<!\S)signed(?!\S)', strl)
            p_dir = pdtmp if pdtmp else p_dir
            if pname:
                if pdtmp:
                    psize = pstmp
                else:
                    psize = psize
                ports_list.append([p_dir, psize, pname])
    except Exception:
        return False
    return True


def get_clock_reset(text: str) -> Tuple[List[str], List[str]]:
    """Extract clock and reset signals from always blocks"""
    alwys = re.compile(r'always\s*@\s*\(.+?\)').findall(text)
    clksl = []
    rstsl = []
    for strl in alwys:
        clk = re.compile(r'(?:posedge)\s+([\w\d]+)').findall(strl)
        clksl.extend(clk)
        rst = re.compile(r'(?:negedge)\s+([\w\d]+)').findall(strl)
        rstsl.extend(rst)
    clkss = set(clksl)
    rstss = set(rstsl)
    return list(clkss), list(rstss)


def parse_module(text: str, settings: Dict[str, Any] = None) -> Tuple[str, List[List[str]], List[List[str]], List[str], List[str]]:
    """
    Parse module definition and extract ports, parameters, clock, and reset signals

    Returns:
        (module_name, ports_list, param_list, clk_list, rst_list)
        ports_list: [[direction, size, name], ...]
        param_list: [[type, param_type, name, value], ...]
    """
    if settings is None:
        settings = {}

    try:
        mcodes = regex_search(r'(?<!\S)module(?!\S).+?(?<!\S)endmodule(?!\S)', text)
        moddef = regex_search(r'module[^;]+;', mcodes)
        prmtmp = regex_search(r'#\s*\(.*\)\s*(?=\()', moddef)
        prmtxt = regex_search(r'(?<=\().*(?=\))', prmtmp)
        moddef = re.sub(r'#\s*\(.*\)\s*(?=\()', '', moddef)
        modmch = re.compile(r'module\s+?(?P<name>\w+)').match(moddef)
        module = modmch.group('name') if modmch else ''
        prttxt = regex_search(r'(?<=\().*(?=\))', moddef)
        if mcodes == '' or moddef == '' or module == '':
            return '', None, None, None, None
    except Exception:
        return '', None, None, None, None

    param_list = []
    if prmtxt:
        parse_param(prmtxt, "parameter", param_list)

    ports_list = []
    if prttxt:
        parse_ports(prttxt, ports_list)

    mcodes = re.sub(re.compile(r'module[^;]+;'), '', mcodes)
    portsl = re.compile(r'(?<!\S)input(?!\S)[^;]+;|(?<!\S)output(?!\S)[^;]+;|(?<!\S)inout(?!\S)[^;]+;').findall(mcodes)
    for ports in portsl:
        p_dir = ''
        psize = ''
        try:
            for strl in ports.split(','):
                strl = re.sub(r'=.*', '', strl)
                pntmp = re.compile(r'\w+').findall(strl)
                pname = pntmp[-1] if len(pntmp) > 0 else ''
                pdtmp = regex_search(r'(?<!\S)input(?!\S)|(?<!\S)output(?!\S)|(?<!\S)inout(?!\S)', strl)
                pstmp = regex_search(r'\[.*\]|(?<!\S)signed\s*\[.*\]|(?<!\S)signed(?!\S)', strl)
                p_dir = pdtmp if pdtmp else p_dir
                if pname:
                    if pdtmp:
                        psize = pstmp
                    else:
                        psize = psize
                    for i, _strl in enumerate(ports_list):
                        if _strl[2] == pname:
                            ports_list[i][0] = p_dir
                            ports_list[i][1] = psize
        except Exception:
            pass

    paramsl = re.compile(r'(?<!\S)parameter(?!\S)[^;]+(?=;)').findall(mcodes)
    for params in paramsl:
        parse_param(params, "parameter", param_list)
    paramsl = re.compile(r'(?<!\S)localparam(?!\S)[^;]+(?=;)').findall(mcodes)
    for params in paramsl:
        parse_param(params, "localparam", param_list)

    ports = [i[2] for i in ports_list]
    clk_list = []
    rst_list = []
    clksl, rstsl = get_clock_reset(mcodes)
    for e in clksl:
        if e in ports:
            clk_list.append(e)
    for e in rstsl:
        if e in ports:
            rst_list.append(e)

    resetl = settings.get('reset', [])
    clockl = settings.get('clock', [])
    for p in ports:
        if p in clockl:
            clk_list.append(p)
        if p in resetl:
            rst_list.append(p)

    return module, ports_list, param_list, clk_list, rst_list


def declare_param(paraml: List[List[str]], ends: str = ';', type: str = '') -> str:
    """Generate parameter declarations"""
    text = ''
    strl = []
    lmax = 0
    prml = []
    for pstr in paraml:
        if type == '' or (type != '' and pstr[0] == type):
            prml.append(pstr)
    for pstr in prml:
        if len(pstr[1]) == 0:
            tmps = pstr[0] + ' ' + pstr[2]
        else:
            tmps = pstr[0] + ' ' + pstr[1] + ' ' + pstr[2]
        lmax = max(lmax, len(tmps))
        strl.append(tmps)
    for i, tmps in enumerate(strl):
        sp = lmax - len(tmps)
        if ends == ';':
            lend = ';\n'
        else:
            lend = '' if i == len(strl) - 1 else ',\n'
        if prml[i][1]:
            text += '\t' + prml[i][0] + ' ' * sp + ' ' + prml[i][1] + ' ' + prml[i][2] + ' = ' + prml[i][3] + lend
        else:
            text += '\t' + prml[i][0] + ' ' * sp + ' ' + prml[i][2] + ' = ' + prml[i][3] + lend
    return text


def declare_sigls(portsl: List[List[str]], clkrstl: List[str], stype: str, ends: str = ';') -> str:
    """Generate signal declarations"""
    text = ''
    strl = []
    lmax = 0
    for pstr in portsl:
        tmps = stype + ' ' + pstr[1]
        lmax = max(lmax, len(tmps))
        strl.append(tmps)
    for i, tmps in enumerate(strl):
        if not portsl[i][2] in clkrstl:
            sp = lmax - len(tmps)
            if ends == ';':
                lend = ';\n'
            else:
                lend = '' if i == len(strl) - 1 else ',\n'
            if lmax == sp:
                text += '\t' + stype + ' ' + ' ' * sp + ' ' + portsl[i][2] + lend
            else:
                text += '\t' + stype + ' ' + ' ' * sp + portsl[i][1] + ' ' + portsl[i][2] + lend
    return text


def module_inst(mod_name: str, port_list: List[List[str]], param_list: List[List[str]],
                clk_list: List[str], rst_list: List[str], srst_list: List[str],
                iprefix: str, outx: bool = False) -> str:
    """Generate module instantiation code"""
    nchars = 0
    lmax = 0
    prmonly_list = []
    for _strl in param_list:
        if _strl[0] == 'parameter':
            nchars = nchars + (len(_strl[2]) * 2 + 5)
            prmonly_list.append(_strl)
    for _strl in port_list:
        nchars = nchars + (len(_strl[2]) * 2 + 5)
        lmax = max(lmax, len(_strl[2]))
    plen = len(prmonly_list)

    if nchars > 80:
        if plen > 0:
            string = "\t" + mod_name + " #(\n"
            for i, _strl in enumerate(prmonly_list):
                string = string + "\t" * 3 + "." + _strl[2] + "(" + _strl[2] + ")"
                if i != plen - 1:
                    string = string + ",\n"
                else:
                    string = string + "\n"
            string = string + "\t" * 2 + ") " + iprefix + mod_name + " (\n"
        else:
            string = "\t" + mod_name + " " + iprefix + mod_name + "\n" + "\t" * 2 + "(\n"
        for i, _strl in enumerate(port_list):
            sp = lmax - len(_strl[2])
            if _strl[0] == 'input' and _strl[2] in clk_list:
                pmap = clk_list[0]
            elif _strl[0] == 'input' and _strl[2] in rst_list:
                pmap = rst_list[0]
            elif _strl[0] == 'input' and _strl[2] in srst_list:
                pmap = srst_list[0]
            else:
                pmap = _strl[2]
            if outx and _strl[0] == 'output':
                string = string + "\t" * 3 + "." + _strl[2] + " " * sp + " ()"
            else:
                string = string + "\t" * 3 + "." + _strl[2] + " " * sp + " (" + pmap + ")"
            if i != len(port_list) - 1:
                string = string + ",\n"
            else:
                string = string + "\n"
        string = string + "\t" * 2 + ");\n"
    else:
        if plen > 0:
            string = "\t" + mod_name + " #("
            for i, _strl in enumerate(prmonly_list):
                string = string + "." + _strl[2] + "(" + _strl[2] + ")"
                if i != plen - 1:
                    string = string + ", "
            string = string + ") " + iprefix + mod_name + " ("
        else:
            string = "\t" + mod_name + " " + iprefix + mod_name + " ("
        for i, _strl in enumerate(port_list):
            if _strl[0] == 'input' and _strl[2] in clk_list:
                pmap = clk_list[0]
            elif _strl[0] == 'input' and _strl[2] in rst_list:
                pmap = rst_list[0]
            elif _strl[0] == 'input' and _strl[2] in srst_list:
                pmap = srst_list[0]
            else:
                pmap = _strl[2]
            if outx and _strl[0] == 'output':
                string = string + "." + _strl[2] + "()"
            else:
                string = string + "." + _strl[2] + "(" + pmap + ")"
            if i != len(port_list) - 1:
                string = string + ", "
        string = string + ");\n"
    return string


def generate_port_declarations(ports_list: List[List[str]], param_list: List[List[str]]) -> str:
    """
    Generate signal declarations for module instantiation
    - input ports: reg declaration
    - output ports: wire declaration
    - inout ports: wire (or tri) declaration
    - parameters: localparam declarations
    Each declaration on a separate line
    """
    text = ""

    # Generate parameter declarations first (if any)
    for pstr in param_list:
        if pstr[0] == 'parameter':
            if pstr[1]:  # Has type/range
                text += f"localparam {pstr[1]} {pstr[2]} = {pstr[3]};\n"
            else:
                text += f"localparam {pstr[2]} = {pstr[3]};\n"

    # Generate signal declarations for ports
    for pstr in ports_list:
        p_dir = pstr[0]      # input, output, or inout
        p_size = pstr[1]     # [7:0], signed, etc.
        p_name = pstr[2]     # port name

        if p_dir == 'input':
            # Input ports use reg declaration
            if p_size:
                text += f"reg {p_size} {p_name};\n"
            else:
                text += f"reg  {p_name};\n"
        elif p_dir == 'output':
            # Output ports use wire declaration
            if p_size:
                text += f"wire {p_size} {p_name};\n"
            else:
                text += f"wire {p_name};\n"
        elif p_dir == 'inout':
            # Inout ports use wire/tri declaration
            if p_size:
                text += f"wire {p_size} {p_name};\n"
            else:
                text += f"wire {p_name};\n"

    return text


def generate_testbench(module: str, ports_list: List[List[str]], param_list: List[List[str]],
                       clk_list: List[str], rst_list: List[str], settings: Dict[str, Any]) -> str:
    """Generate testbench code"""
    if settings is None:
        settings = {}

    iprefix = settings.get("inst_prefix", "inst_")
    resetl = settings.get('reset', [])
    sresetl = settings.get('sreset', [])
    clockl = settings.get('clock', [])

    resetl = resetl + rst_list
    sresetl = sresetl
    clockl = clockl + clk_list
    clkrstl = clockl + resetl + sresetl

    declp = declare_param(param_list)
    decls = declare_sigls(ports_list, clkrstl, 'logic')
    minst = module_inst(module, ports_list, param_list, clockl, resetl, sresetl, iprefix, False)

    # Wave dump
    wtype = settings.get("wave_type", "")
    str_dump = ""
    if wtype == "fsdb":
        str_dump = """
\tif ( $test$plusargs("fsdb") ) begin
\t\t$fsdbDumpfile("tb_""" + module + """.fsdb");
\t\t$fsdbDumpvars(0, "tb_""" + module + """", "+mda", "+functions");
\tend"""
    elif wtype == "vpd":
        str_dump = """
\t$vcdplusfile("tb_""" + module + """.vpd");
\t$vcdpluson(0, "tb_""" + module + """");"""
    elif wtype == "shm":
        str_dump = """
\t$shm_open("tb_""" + module + """.shm");
\t$shm_probe();"""
    elif wtype == "vcd":
        str_dump = """
\tif ( $test$plusargs("vcd") ) begin
\t\t$dumpfile("tb_""" + module + """.vcd");
\t\t$dumpvars(0, "tb_""" + module + """");
\tend"""

    declp = '' if len(declp) == 0 else declp + '\n'
    decls = '' if len(decls) == 0 else decls + '\n'

    arstb = resetl[0] if len(resetl) > 0 else ''
    srstb = sresetl[0] if len(sresetl) > 0 else ''
    clock = clockl[0] if len(clockl) > 0 else ''

    # Clock generation
    sclks = ''
    if clock:
        sclks = """
\t// clock
\tlogic """ + clock + """;
\tinitial begin
\t\t""" + clock + """ = '0;
\t\tforever #(0.5) """ + clock + """ = ~""" + clock + """;
\tend\n"""

    # Asynchronous reset
    arsts = ''
    if arstb:
        arsts = """
\t// asynchronous reset
\tlogic """ + arstb + """;
\tinitial begin
\t\t""" + arstb + """ <= '0;
\t\t#10
\t\t""" + arstb + """ <= '1;
\tend\n"""

    # Synchronous reset
    srsts = ''
    if srstb:
        srsts = """
\t// synchronous reset
\tlogic """ + srstb + """;
\tinitial begin
\t\t""" + srstb + """ <= '0;
\t\trepeat(5)@(posedge """ + clock + """);
\t\t""" + srstb + """ <= '1;
\tend\n"""

    # Task init
    tskit = settings.get('task_init', True)
    if tskit:
        taski = _task_init(ports_list, clkrstl)
        if clock:
            dtski = '\n\t\tinit();\n\t\trepeat(10)@(posedge ' + clock + ');\n'
        else:
            dtski = '\t\tinit();\n\n'
    else:
        taski = ''
        dtski = ''

    # Task drive
    tskdt = settings.get('task_drive', True)
    if tskdt:
        taskd = _task_drive(ports_list, clkrstl, clock)
        dtskd = '\n\t\tdrive(20);\n'
    else:
        taskd = ''
        dtskd = ''

    tbcodes = """`timescale 1ns/1ps
module tb_""" + module + """ (); /* this is automatically generated */
""" + sclks + arsts + srsts + """
\t// (*NOTE*) replace reset, clock, others
""" + declp + decls + minst + taski + taskd + """
\tinitial begin
\t\t// do something
""" + dtski + dtskd + """
\t\trepeat(10)@(posedge """ + clock + """);
\t\t$finish;
\tend

\t// dump wave
\tinitial begin
\t\t$display("random seed : %0d", $unsigned($get_initial_random_seed()));""" + str_dump + """
\tend

endmodule
"""
    return tbcodes


def _task_init(portsl: List[List[str]], clkrstl: List[str]) -> str:
    """Generate init task"""
    text = '\n\ttask init();\n'
    for pstr in portsl:
        if pstr[0] == 'input' and (not pstr[2] in clkrstl):
            text += '\t\t' + pstr[2] + ' <= \'0;\n'
    text += '\tendtask\n'
    return text


def _task_drive(portsl: List[List[str]], clkrstl: List[str], tclock: str) -> str:
    """Generate drive task"""
    text = '\n\ttask drive(int iter);\n'
    text += '\t\tfor(int it = 0; it < iter; it++) begin\n'
    for pstr in portsl:
        if pstr[0] == 'input' and (not pstr[2] in clkrstl):
            text += '\t\t\t' + pstr[2] + ' <= \'0;\n'
    if tclock:
        text += '\t\t\t@(posedge '+tclock+');\n\t\tend\n'
    else:
        text += '\t\tend\n'
    text += '\tendtask\n'
    return text


def generate_header_template(template: str, file_name: str, tab_size: int = 4) -> str:
    """Generate header from template with placeholders replaced"""
    cyear = str(datetime.datetime.now().year)
    cdate = datetime.datetime.now().strftime('%Y-%m-%d')
    ctime = datetime.datetime.now().strftime('%H:%M:%S')
    rdate = datetime.datetime.now().strftime('%Y-%m-%d')
    rtime = datetime.datetime.now().strftime('%H:%M:%S')
    tabsz = str(tab_size)

    fname = os.path.basename(file_name) if file_name else ""

    ntext = template
    ntext = ntext.replace('{YEAR}', cyear)
    ntext = ntext.replace('{FILE}', fname)
    ntext = ntext.replace('{DATE}', cdate)
    ntext = ntext.replace('{TIME}', ctime)
    ntext = ntext.replace('{RDATE}', rdate)
    ntext = ntext.replace('{RTIME}', rtime)
    ntext = ntext.replace('{TABS}', tabsz)

    return ntext


def repeat_code_with_numbers(template: str, start: int, end: int, row_step: int = 1,
                             col_step: int = 0, clipboard_lines: List[str] = None) -> str:
    """
    Repeat code with number formatting

    Args:
        template: Code template with format placeholders like {:d}, {0:03x}, etc.
        start: Starting number
        end: Ending number (exclusive if step is positive, inclusive if step is negative)
        row_step: Step for each row
        col_step: Step for each placeholder in the same row
        clipboard_lines: Lines from clipboard to use with {cb} placeholder

    Returns:
        Generated code with repeated lines
    """
    try:
        if start <= end:
            end = end + 1
            rsp_n = row_step
            csp_n = col_step
        else:
            end = end - 1
            rsp_n = -row_step
            csp_n = col_step

        rng_len = len(range(start, end, rsp_n))
        if rng_len < 1:
            raise ValueError("Invalid range")

        # Check for {cb} placeholder
        clb_f = '{cb}' in template
        clb_s = clipboard_lines if clipboard_lines else []

        # Count placeholders
        tup_n = template.count('{}')
        if tup_n == 0:
            # Try to find explicit format specs like {0:d}, {:03x}
            tup_n = len(re.findall(r'\{[^}]*\}', template))

        _repeat_ = ""
        cidx = 0
        for i in range(start, end, rsp_n):
            prm_l = []
            if clb_f:
                if i < len(clb_s):
                    r_txt = template.replace('{cb}', clb_s[cidx])
                    cidx += 1
                else:
                    r_txt = template.replace('{cb}', clb_s[-1] if clb_s else '')
            else:
                r_txt = template

            for j in range(tup_n):
                prm_l.append(i + j * csp_n)

            try:
                _repeat_ = _repeat_ + '\n' + r_txt.format(*prm_l)
            except IndexError:
                # Try with numbered placeholders
                _repeat_ = _repeat_ + '\n' + r_txt.format(*[prm_l[k] if k < len(prm_l) else i for k in range(tup_n)])

        return _repeat_.lstrip()

    except Exception as e:
        raise ValueError(f"Format error: {str(e)}")


def align_code(text: str, tab_size: int = 4) -> str:
    """
    Align Verilog code based on assignment operators

    Supports:
    - General assignment alignment (lhs = rhs)
    - Port declaration alignment (input/output/inout type range name)
    - Signal declaration alignment (reg/wire/logic signed range name)
    - Instance port alignment (.port(conn))
    """
    lines = text.split('\n')
    aligned_lines = []

    # Determine alignment type
    atyp = -1
    for l in lines:
        lstr = l.strip()
        if lstr:
            if re.match(r'^\s*(input|output|inout)', lstr):
                atyp = 1
                break
            elif re.match(r'^\s*(reg|wire|logic)', lstr):
                atyp = 2
                break
            elif re.match(r'^\s*\.\w+\s*\(', lstr):
                atyp = 3
                break
            else:
                atyp = 0
                break

    if atyp == 0:
        # General assignment alignment
        return _align_assignment(text, tab_size)
    elif atyp == 1:
        return _align_port_declaration(text, tab_size)
    elif atyp == 2:
        return _align_signal_declaration(text, tab_size)
    elif atyp == 3:
        return _align_instance_port(text, tab_size)

    return text


def _align_assignment(text: str, tab_size: int) -> str:
    """Align code by assignment operators"""
    REGXEXC = r"\s*if[^\w]|\s*for[^\w]"
    REGXLHS = r".*?[\w\]\}](?=\s*\|=)|.*?[\w\]\}](?=\s*~=)|.*?[\w\]\}](?=\s*-=)|.*?[\w\]\}](?=\s*\+=)|.*?[\w\]\}](?=\s*<=)|.*?[\w\]\}](?=\s*=[^=])"
    REGXRHS = r"\|=.*|~=.*|-=.*|\+=.*|<=.*|=.*"

    lines = text.split('\n')
    max_lhs = 0

    def len_tab(stxt, tabs):
        slen = 0
        for c in stxt:
            slen += (tabs - slen % tabs) if c == '\t' else 1
        return slen

    # First pass: find max LHS length
    for l in lines:
        if re.match(REGXEXC, l):
            continue
        lhsl = re.findall(REGXLHS, l)
        if lhsl:
            lhs_len = len_tab(lhsl[0], tab_size)
            max_lhs = max(max_lhs, lhs_len)

    # Second pass: align
    result = []
    for l in lines:
        if re.match(REGXEXC, l):
            result.append(l)
            continue

        lhsl = re.findall(REGXLHS, l)
        rhsl = re.findall(REGXRHS, l)
        if lhsl and rhsl:
            lhsn = lhsl[0]
            rhsn = rhsl[0]
            padding = ' ' * (max_lhs - len_tab(lhsn, tab_size) + 1)
            result.append(lhsn + padding + rhsn)
        else:
            result.append(l)

    return '\n'.join(result)


def _align_port_declaration(text: str, tab_size: int) -> str:
    """Align port declarations (input/output/inout)"""
    REGXPDC = r'^(?P<indent>\s*)(?P<inout>(input|output|inout))\s*(?P<type>(reg|wire|logic|))\s*(?P<signed>(signed|))\s*(?P<range>(\[.*?\]|))\s*(?P<name>.*?)\Z'

    lines = text.split('\n')
    items = []
    max_len = 0

    def len_tab(stxt, tabs):
        slen = 0
        for c in stxt:
            slen += (tabs - slen % tabs) if c == '\t' else 1
        return slen

    for l in lines:
        mtch = re.match(REGXPDC, l, re.DOTALL)
        if mtch:
            prefix = mtch.group('indent') + mtch.group('inout')
            prefix += (' ' if mtch.group('type') else '') + mtch.group('type')
            prefix += (' ' if mtch.group('signed') else '') + mtch.group('signed')
            prefix += ('\t' if mtch.group('range') else '') + mtch.group('range')
            name = mtch.group('name')
            items.append((prefix, name))
            max_len = max(max_len, len_tab(prefix, tab_size))
        else:
            items.append((l, None))

    max_len = max_len + (tab_size - max_len % tab_size)

    result = []
    for i, (prefix, name) in enumerate(items):
        if name is not None:
            padding = '\t' * ((max_len - len_tab(prefix, tab_size) + tab_size - 1) // tab_size)
            result.append(prefix + padding + name)
        else:
            result.append(prefix)

    return '\n'.join(result)


def _align_signal_declaration(text: str, tab_size: int) -> str:
    """Align signal declarations (reg/wire/logic)"""
    REGXSDC = r'^(?P<indent>\s*)(?P<type>(reg|wire|logic))\s*(?P<signed>(signed|))\s*(?P<range>(\[.*?\]|))\s*(?P<name>.*?)\Z'

    lines = text.split('\n')
    items = []
    max_len = 0

    def len_tab(stxt, tabs):
        slen = 0
        for c in stxt:
            slen += (tabs - slen % tabs) if c == '\t' else 1
        return slen

    for l in lines:
        mtch = re.match(REGXSDC, l, re.DOTALL)
        if mtch:
            prefix = mtch.group('indent') + mtch.group('type')
            prefix += (' ' if mtch.group('signed') else '') + mtch.group('signed')
            prefix += ('\t' if mtch.group('range') else '') + mtch.group('range')
            name = mtch.group('name')
            items.append((prefix, name))
            max_len = max(max_len, len_tab(prefix, tab_size))
        else:
            items.append((l, None))

    max_len = max_len + (tab_size - max_len % tab_size)

    result = []
    for i, (prefix, name) in enumerate(items):
        if name is not None:
            padding = '\t' * ((max_len - len_tab(prefix, tab_size) + tab_size - 1) // tab_size)
            result.append(prefix + padding + name)
        else:
            result.append(prefix)

    return '\n'.join(result)


def _align_instance_port(text: str, tab_size: int) -> str:
    """Align instance ports (.port(conn))"""
    REGXINS = r'^(?P<indent>\s*)(?P<port>\.\w+)\s*(?P<conn>\(.*?)\Z'

    lines = text.split('\n')
    items = []
    max_len = 0

    def len_tab(stxt, tabs):
        slen = 0
        for c in stxt:
            slen += (tabs - slen % tabs) if c == '\t' else 1
        return slen

    for l in lines:
        mtch = re.match(REGXINS, l, re.DOTALL)
        if mtch:
            port = mtch.group('indent') + mtch.group('port')
            conn = mtch.group('conn')
            items.append((port, conn))
            max_len = max(max_len, len_tab(port, tab_size))
        else:
            items.append((l, None))

    max_len = max_len + 1

    result = []
    for i, (port, conn) in enumerate(items):
        if conn is not None:
            padding = ' ' * (max_len - len_tab(port, tab_size))
            result.append(port + padding + conn)
        else:
            result.append(port)

    return '\n'.join(result)
