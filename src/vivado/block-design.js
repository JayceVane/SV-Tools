'use strict';

const path = require('node:path');
const { literal, filePath, properties, requireName, requireVlnv, rowsOf } = require('./asset-task');

const select = file => [
    'set bd [sv_file ' + filePath(file) + ' [get_files -quiet *.bd]]',
    'open_bd_design $bd'
];
const edit = body => [...body, 'save_bd_design'];

function create(name) {
    return edit([
        'set name ' + requireName(name),
        'foreach file [get_files -quiet *.bd] {',
        '    if {[string equal -nocase [file rootname [file tail $file]] $name]} { error "Block Design already exists: $name" }',
        '}',
        'create_bd_design $name',
        'set created [get_files -quiet $name.bd]',
        'if {[llength $created] != 1} { error "Unable to resolve new Block Design: $name" }',
        'sv_row created [lindex $created 0]'
    ]);
}

function importSource(filename) {
    if (!path.isAbsolute(filename) || !/\.bd$/iu.test(filename)) throw new Error('请选择 .bd 文件');
    return [
        'set file ' + filePath(filename),
        'if {![file isfile $file]} { error "Block Design unavailable: $file" }',
        'foreach existing [get_files -quiet *.bd] {',
        '    if {[string equal -nocase [file tail $existing] [file tail $file]]} { error "Block Design name already exists" }',
        '}',
        'add_files -norecurse [list $file]'
    ];
}

function inspect() {
    return [
        'sv_row design [current_bd_design]',
        'foreach cell [get_bd_cells -quiet -hierarchical] {',
        '    sv_row cell $cell [sv_prop $cell TYPE] [sv_prop $cell VLNV]',
        '}',
        'foreach pin [get_bd_pins -quiet -hierarchical] {',
        '    sv_row pin $pin [sv_prop $pin DIR] [sv_prop $pin TYPE] [sv_prop $pin LEFT] [sv_prop $pin RIGHT]',
        '}',
        'foreach pin [get_bd_intf_pins -quiet -hierarchical] {',
        '    sv_row interface_pin $pin [sv_prop $pin MODE] [sv_prop $pin VLNV]',
        '    sv_row interface_members $pin {*}[get_bd_pins -quiet -of_objects $pin]',
        '}',
        'foreach port [get_bd_ports -quiet] {',
        '    sv_row port $port [sv_prop $port DIR] [sv_prop $port TYPE] [sv_prop $port LEFT] [sv_prop $port RIGHT]',
        '}',
        'foreach port [get_bd_intf_ports -quiet] {',
        '    sv_row interface_port $port [sv_prop $port MODE] [sv_prop $port VLNV]',
        '    sv_row interface_members $port {*}[get_bd_ports -quiet -of_objects $port]',
        '}',
        'foreach net [get_bd_nets -quiet -hierarchical] {',
        '    sv_row net $net {*}[get_bd_pins -quiet -of_objects $net] {*}[get_bd_ports -quiet -of_objects $net]',
        '}',
        'foreach net [get_bd_intf_nets -quiet -hierarchical] {',
        '    sv_row interface_net $net {*}[get_bd_intf_pins -quiet -of_objects $net] {*}[get_bd_intf_ports -quiet -of_objects $net]',
        '}',
        'foreach space [get_bd_addr_spaces -quiet] {',
        '    set ports [get_bd_intf_ports -quiet -of_objects $space]',
        '    set pins [get_bd_intf_pins -quiet -of_objects $space]',
        '    set ownerKind ""; set owner ""; set ownerMode ""',
        '    if {[llength $ports] == 1} {',
        '        set owner [lindex $ports 0]; set ownerKind port; set ownerMode [sv_prop $owner MODE]',
        '    } elseif {[llength $pins] == 1} {',
        '        set owner [lindex $pins 0]; set ownerKind pin; set ownerMode [sv_prop $owner MODE]',
        '    }',
        '    sv_row address_space $space [sv_prop $space RANGE] $ownerKind $owner $ownerMode',
        '    foreach segment [get_bd_addr_segs -quiet -of_objects $space] {',
        '        sv_row address $space $segment [sv_prop $segment NAME] [sv_prop $segment OFFSET] [sv_prop $segment RANGE]',
        '    }',
        '}'
    ];
}

const read = file => [...select(file), ...inspect()];

const endpointKinds = {
    pin: 'get_bd_pins -quiet -hierarchical',
    interface_pin: 'get_bd_intf_pins -quiet -hierarchical',
    port: 'get_bd_ports -quiet',
    interface_port: 'get_bd_intf_ports -quiet'
};
const isInterface = item => item.kind.startsWith('interface_');
const bdObject = (query, id) => '[sv_exact [' + query + '] ' + literal(id) + ' "Block Design object"]';
const cell = id => bdObject('get_bd_cells -quiet -hierarchical', id);
const net = item => bdObject(isInterface(item) ? 'get_bd_intf_nets -quiet -hierarchical' : 'get_bd_nets -quiet -hierarchical', item.id);
function endpoint(item) {
    if (!Object.hasOwn(endpointKinds, item.kind)) throw new Error('无效的 Block Design 端点类型');
    return bdObject(endpointKinds[item.kind], item.id);
}

function snapshot(rows) {
    const members = new Map(), interfaces = new Map();
    for (const [id, ...pins] of rowsOf(rows, 'interface_members')) {
        if (!pins.length) continue;
        members.set(id, pins);
        for (const pin of pins) interfaces.set(pin, id);
    }
    return {
        name: rowsOf(rows, 'design')[0]?.[0],
        cells: rowsOf(rows, 'cell').map(([id, type, vlnv]) => ({ id, type: vlnv.split(':')[1] === 'module_ref' ? 'module' : type, vlnv })),
        endpoints: rows.filter(([kind]) => Object.hasOwn(endpointKinds, kind))
            .map(([kind, id, direction, type, left, right]) => ({
                id, kind, direction, type, left, right, cell: kind.endsWith('pin') ? id.slice(0, id.lastIndexOf('/')) : '',
                ...(kind.startsWith('interface_') ? { members: members.get(id) } : { interfaceId: interfaces.get(id) })
            })),
        nets: rows.filter(([kind]) => ['net', 'interface_net'].includes(kind)).map(([kind, id, ...endpoints]) => ({ id, kind, endpoints })),
        addresses: rowsOf(rows, 'address').map(([space, id, name, offset, range]) => ({ space, id, name, offset, range })),
        spaces: rowsOf(rows, 'address_space').map(([id, range, kind, owner, mode]) => ({
            id, range,
            owner: { kind: kind || '', id: owner || '', mode: mode || '' },
            segments: rowsOf(rows, 'address').filter(([space]) => space === id)
                .map(([, segment, name, offset, size]) => ({ id: segment, name: name || segment.slice(segment.lastIndexOf('/') + 1), offset, range: size }))
        }))
    };
}

function addCell(file, { type, reference, name, parent }) {
    const prefix = parent ? ['current_bd_instance ' + cell(parent)] : [];
    const driver = {
        ip: () => '-type ip -vlnv [sv_exact [get_ipdefs -quiet -all] ' + requireVlnv(reference) + ' "IP definition"]',
        module: () => '-type module -reference ' + requireName(reference),
        hier: () => '-type hier'
    };
    if (!Object.hasOwn(driver, type)) throw new Error('无效的 Block Design 模块类型');
    return [...select(file), ...edit([...prefix, 'create_bd_cell ' + driver[type]() + ' ' + requireName(name), 'current_bd_instance /'])];
}

const parameters = (file, id) => [...select(file), 'set item ' + cell(id), 'sv_parameters $item'];
const configure = (file, id, changes) => [...select(file), ...edit(['set item ' + cell(id), ...properties(changes, '$item')])];
const portParameters = (file, item) => [...select(file), 'set item ' + endpoint(item), 'sv_parameters $item'];
const configurePort = (file, item, changes) => [...select(file), ...edit(['set item ' + endpoint(item), ...properties(changes, '$item')])];

function connect(file, from, to, existing, level = '') {
    const useInterface = isInterface(from);
    if (useInterface !== isInterface(to) || from.id === to.id) throw new Error('请选择两个不同且类型相同的端点');
    const cmd = useInterface ? 'connect_bd_intf_net' : 'connect_bd_net';
    const tail = existing ? (useInterface ? ' -intf_net $link' : ' -net $link') : '';
    return [...select(file), ...edit([
        'set from ' + endpoint(from),
        'set to ' + endpoint(to),
        ...(existing ? ['set link ' + net(existing)] : []),
        ...(level ? ['current_bd_instance ' + cell(level)] : []),
        cmd + tail + ' $from $to',
        'current_bd_instance /'
    ])];
}

const disconnect = (file, link, item) => [...select(file), ...edit([
    (isInterface(link) ? 'disconnect_bd_intf_net ' : 'disconnect_bd_net ') + net(link) + ' ' + endpoint(item)
])];
const remove = (file, kind, item) => [...select(file), ...edit(['delete_bd_objs ' + (
    kind === 'cell' ? cell(item.id) : kind === 'net' ? net(item) : endpoint(item))])];

function externalize(file, item) {
    if (!item.kind.endsWith('pin')) throw new Error('请选择模块引脚或接口');
    return [...select(file), ...edit([(isInterface(item) ? 'make_bd_intf_pins_external ' : 'make_bd_pins_external ') + endpoint(item)])];
}

function addPort(file, { name, direction, width, type }) {
    if (!['I', 'O', 'IO'].includes(direction) || !Number.isSafeInteger(width) || width < 1) throw new Error('无效的端口方向或位宽');
    if (!['data', 'clk', 'rst'].includes(type)) throw new Error('无效的端口类型');
    const bits = width === 1 ? '' : ' -from ' + (width - 1) + ' -to 0';
    return [...select(file), ...edit(['create_bd_port -dir ' + direction + (type === 'data' ? '' : ' -type ' + type) + bits + ' ' + requireName(name)])];
}

function addInterfacePort(file, { name, mode, vlnv }) {
    if (!['Master', 'Slave', 'Monitor'].includes(mode)) throw new Error('无效的接口方向');
    return [...select(file), ...edit(['create_bd_intf_port -mode ' + mode + ' -vlnv ' + requireVlnv(vlnv) + ' ' + requireName(name)])];
}

/** 校验十六进制地址：只接受 0x 前缀的无符号整数，避免把 Tcl 表达式带进脚本。 */
function addressValue(value, label) {
    const text = String(value === undefined || value === null ? '' : value).replace(/_/gu, '');
    if (!/^0[xX][0-9a-fA-F]{1,16}$/u.test(text)) throw new Error(label + '须为 0x 前缀的十六进制地址');
    return literal(text);
}

const addressSegment = id => 'set segment [sv_exact [get_bd_addr_segs -quiet] ' + literal(id) + ' "Address segment"]';

/** 修改已映射段：Vivado 按主设备 aperture 校验，越界会直接报错。 */
function setAddress(file, id, { offset, range }) {
    return [...select(file), ...edit([
        addressSegment(id),
        'if {[catch { set_property range ' + addressValue(range, '范围') + ' $segment } message]} { error "范围无效：$message" }',
        'if {[catch { set_property offset ' + addressValue(offset, '偏移地址') + ' $segment } message]} { error "偏移地址无效：$message" }'
    ])];
}

/** 把未映射的从设备段分配进主地址空间（对应 Vivado Address Editor 的映射操作）。 */
function mapAddress(file, { space, segment, offset, range }) {
    return [...select(file), ...edit([
        'set space [sv_exact [get_bd_addr_spaces -quiet] ' + literal(space) + ' "Address space"]',
        addressSegment(segment),
        'if {[catch { assign_bd_address -target_address_space $space -offset ' + addressValue(offset, '偏移地址')
            + ' -range ' + addressValue(range, '范围') + ' $segment } message]} { error "地址映射失败：$message" }'
    ])];
}

const assignAddresses = file => [...select(file), ...edit(['assign_bd_address'])];
const validate = file => [...select(file), ...edit(['validate_bd_design'])];
const generate = file => [...validate(file), 'generate_target all $bd'];
const wrapper = file => [...generate(file), 'make_wrapper -files $bd -top -import', 'update_compile_order -fileset [current_fileset]'];
const exportTcl = file => [...select(file), 'write_bd_tcl [file join [pwd] block-design.tcl]', 'sv_row artifact block-design.tcl'];

module.exports = { create, importSource, read, inspect, snapshot, isInterface, addCell, parameters, configure, connect, disconnect, remove,
    externalize, addPort, addInterfacePort, portParameters, configurePort, assignAddresses, setAddress, mapAddress, addressValue,
    validate, generate, wrapper, exportTcl };
