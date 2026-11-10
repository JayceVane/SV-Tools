'use strict';

/** 同一模块与同一边界接口的成员连接合成一个虚拟端点，不借用某根物理引脚。 */
function boundaryPeerGroups(arch, boundaries) {
    const tables = new Map(boundaries.filter(node=>node.boundaryTable).flatMap(node=>(node.rows || node.ports).map(row=>[row.sourceNodeId,node])));
    const groups = new Map();
    for (const edge of [...(arch.graph.edges || []), ...(arch.interfaces || []).flatMap(item=>item.bindings || [])]) {
        for (const [boundary,peer,port] of [[edge.sourceNode,edge.targetNode,edge.targetPort],[edge.targetNode,edge.sourceNode,edge.sourcePort]]) {
            const table=tables.get(boundary);
            if (!table || !peer?.startsWith('instance:')) continue;
            if (!groups.has(peer)) groups.set(peer,new Map());
            const byTable=groups.get(peer);
            if (!byTable.has(table.id)) byTable.set(table.id,{id:table.id,name:table.name,side:table.ports[0].side==='WEST'?'EAST':'WEST',names:new Set()});
            byTable.get(table.id).names.add(port);
        }
    }
    return new Map([...groups].map(([id,values])=>[id,[...values.values()]]));
}

function aggregatePeerPorts(node, ports, groups = []) {
    let result=ports;
    for (const group of groups) {
        const selected=result.filter(port=>(port.members || [{name:port.label}]).every(member=>group.names.has(member.name)));
        if (!selected.length) continue;
        if (selected.length===1) { selected[0].interfaceLevel=true; continue; }
        const members=node.ports.filter(port=>group.names.has(port.name)).map(port=>({name:port.name,width:port.width,direction:port.direction}));
        const width=members.reduce((total,port)=>total+port.width,0), directions=new Set(members.map(port=>port.direction));
        const combined={id:node.id+'/interface:'+group.id,label:group.name,displayLabel:group.name+' ['+width+']',
            direction:directions.size===1?[...directions][0]:'inout',width,bitWidth:width,bits:[],members,prefix:null,collapsed:false,
            layoutSide:group.side,interfaceLevel:true,virtualInterface:true};
        const chosen=new Set(selected), first=selected[0];
        result=result.flatMap(port=>port===first?[combined]:chosen.has(port)?[]:[port]);
    }
    return result;
}
module.exports={boundaryPeerGroups,aggregatePeerPorts};
