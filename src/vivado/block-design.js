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
        '}',
        'foreach port [get_bd_ports -quiet] {',
        '    sv_row port $port [sv_prop $port DIR] [sv_prop $port TYPE] [sv_prop $port LEFT] [sv_prop $port RIGHT]',
        '}',
        'foreach port [get_bd_intf_ports -quiet] {',
        '    sv_row interface_port $port [sv_prop $port MODE] [sv_prop $port VLNV]',
        '}',
        'foreach net [get_bd_nets -quiet -hierarchical] {',
        '    sv_row net $net {*}[get_bd_pins -quiet -of_objects $net] {*}[get_bd_ports -quiet -of_objects $net]',
        '}',
        'foreach net [get_bd_intf_nets -quiet -hierarchical] {',
        '    sv_row interface_net $net {*}[get_bd_intf_pins -quiet -of_objects $net] {*}[get_bd_intf_ports -quiet -of_objects $net]',
        '}',
        'foreach space [get_bd_addr_spaces -quiet] {',
        '    foreach segment [get_bd_addr_segs -quiet -of_objects $space] {',
        '        sv_row address $space $segment [sv_prop $segment OFFSET] [sv_prop $segment RANGE]',
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
    return {
        name: rowsOf(rows, 'design')[0]?.[0],
        cells: rowsOf(rows, 'cell').map(([id, type, vlnv]) => ({ id, type: vlnv.split(':')[1] === 'module_ref' ? 'module' : type, vlnv })),
        endpoints: rows.filter(([kind]) => Object.hasOwn(endpointKinds, kind))
            .map(([kind, id, direction, type, left, right]) => ({ id, kind, direction, type, left, right, cell: kind.endsWith('pin') ? id.slice(0, id.lastIndexOf('/')) : '' })),
        nets: rows.filter(([kind]) => ['net', 'interface_net'].includes(kind)).map(([kind, id, ...endpoints]) => ({ id, kind, endpoints })),
        addresses: rowsOf(rows, 'address').map(([space, id, offset, range]) => ({ space, id, offset, range }))
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

const assignAddresses = file => [...select(file), ...edit(['assign_bd_address'])];
const validate = file => [...select(file), ...edit(['validate_bd_design'])];
const generate = file => [...validate(file), 'generate_target all $bd'];
const wrapper = file => [...generate(file), 'make_wrapper -files $bd -top -import', 'update_compile_order -fileset [current_fileset]'];
const exportTcl = file => [...select(file), 'write_bd_tcl [file join [pwd] block-design.tcl]', 'sv_row artifact block-design.tcl'];

module.exports = { create, importSource, read, inspect, snapshot, isInterface, addCell, parameters, configure, connect, disconnect, remove,
    externalize, addPort, addInterfacePort, portParameters, configurePort, assignAddresses, validate, generate, wrapper, exportTcl };
