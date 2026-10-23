/* 波形绘制所需的1:1 Canvas子集，向SVG记录矢量命令；不模拟完整Canvas状态机。 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SvgCanvas=factory();})(typeof window==='object'?window:globalThis,function(){
    'use strict';
    const MAX_CHARS=24*1024*1024, MAX_ELEMENTS=250000;
    const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));
    const number=value=>{if(!Number.isFinite(value))throw new Error('导出坐标不是有限数值');return Math.round(value*1000)/1000;};
    /** @param {{prefix?:string,measure?:Function}} options @returns {object} 仅支持当前波形renderer的绘制合同。 */
    function createContext({prefix='drawing',measure}={}){
        const output=[],definitions=[],stack=[];let path=[],clips=[],dash=[],chars=0,count=0;
        const ctx={fillStyle:'#000',strokeStyle:'#000',lineWidth:1,globalAlpha:1,font:'11px Consolas, monospace',lineJoin:'miter',lineCap:'butt'};
        function emit(content){
            content=clips.reduceRight((body,id)=>`<g clip-path="url(#${id})">${body}</g>`,content);
            chars+=content.length;if(chars>MAX_CHARS||++count>MAX_ELEMENTS)throw new Error('矢量图超过导出预算，请缩小区间或减少信号');output.push(content);
        }
        const stroke=()=>`fill="none" stroke="${escape(ctx.strokeStyle)}" stroke-width="${number(ctx.lineWidth)}" stroke-linejoin="${escape(ctx.lineJoin)}" stroke-linecap="${escape(ctx.lineCap)}"${dash.length?` stroke-dasharray="${dash.map(number).join(' ')}"`:''} opacity="${number(ctx.globalAlpha)}"`;
        ctx.setTransform=(a,b,c,d,e,f)=>{if(a!==1||b!==0||c!==0||d!==1||e!==0||f!==0)throw new Error('SVG绘制只接受1:1逻辑坐标');};
        ctx.save=()=>stack.push({fillStyle:ctx.fillStyle,strokeStyle:ctx.strokeStyle,lineWidth:ctx.lineWidth,globalAlpha:ctx.globalAlpha,font:ctx.font,lineJoin:ctx.lineJoin,lineCap:ctx.lineCap,clips:clips.slice(),dash:dash.slice()});
        ctx.restore=()=>{const saved=stack.pop();if(!saved)throw new Error('SVG绘制状态栈不匹配');clips=saved.clips;dash=saved.dash;for(const key of ['fillStyle','strokeStyle','lineWidth','globalAlpha','font','lineJoin','lineCap'])ctx[key]=saved[key];};
        ctx.beginPath=()=>{path=[];};
        ctx.moveTo=(x,y)=>path.push(`M ${number(x)} ${number(y)}`);ctx.lineTo=(x,y)=>path.push(`L ${number(x)} ${number(y)}`);
        ctx.rect=(x,y,w,h)=>{ctx.moveTo(x,y);ctx.lineTo(x+w,y);ctx.lineTo(x+w,y+h);ctx.lineTo(x,y+h);path.push('Z');};
        ctx.closePath=()=>path.push('Z');ctx.stroke=()=>{if(path.length)emit(`<path d="${path.join(' ')}" ${stroke()}/>`);};
        ctx.fillRect=(x,y,w,h)=>{if(w>0&&h>0&&ctx.globalAlpha>0)emit(`<rect x="${number(x)}" y="${number(y)}" width="${number(w)}" height="${number(h)}" fill="${escape(ctx.fillStyle)}" opacity="${number(ctx.globalAlpha)}"/>`);};
        ctx.strokeRect=(x,y,w,h)=>emit(`<rect x="${number(x)}" y="${number(y)}" width="${number(w)}" height="${number(h)}" ${stroke()}/>`);
        ctx.setLineDash=value=>{dash=value.slice();};
        ctx.clip=()=>{const id=prefix+'-clip-'+definitions.length;definitions.push(`<clipPath id="${id}"><path d="${path.join(' ')}"/></clipPath>`);clips.push(id);};
        ctx.measureText=value=>({width:measure?measure(String(value),ctx.font):[...String(value)].reduce((sum,ch)=>sum+(/[^\x00-\x7f]/.test(ch)?11:6),0)});
        function label(value,x,y,isStroke){const font=ctx.font.match(/(\d+(?:\.\d+)?)px\s+(.+)/);emit(`<text x="${number(x)}" y="${number(y)}" font-size="${font?font[1]:11}" font-family="${escape(font?font[2]:'monospace')}" ${isStroke?stroke():`fill="${escape(ctx.fillStyle)}" opacity="${number(ctx.globalAlpha)}"`}>${escape(value)}</text>`);}
        ctx.fillText=(value,x,y)=>label(value,x,y,false);ctx.strokeText=(value,x,y)=>label(value,x,y,true);
        ctx.content=()=>`<defs>${definitions.join('')}</defs>${output.join('')}`;
        return ctx;
    }
    return {escape,createContext,MAX_CHARS};
});
