export type FactSourceKind = 'metadata' | 'education' | 'experience' | 'skills' | 'summary' | 'unknown';
export interface SemanticFactSource {id:string; text:string; source:string; title:string; kind:FactSourceKind; start:number; end:number; sourceContext?:string}
interface Line {text:string; start:number; end:number; blankBefore:boolean}
const cleanHeading=(text:string)=>text.replace(/^[\s▌■□◆◇▪▶►•·#●]+/u,'').replace(/[：:]\s*$/u,'').trim();
function sectionKind(text:string):FactSourceKind|undefined {
  const value=cleanHeading(text);
  if (/^(?:基本|个人|联系)(?:信息|资料|方式)$|^(?:个人|求职)?简历$/u.test(value))return 'metadata';
  if (/^教育(?:背景|经历)$|^学历信息$/u.test(value))return 'education';
  if (/^(?:核心|个人|专业)优势$|^自我评价$|^个人简介$/u.test(value))return 'summary';
  if (/^(?:专业|个人)?技能(?:证书|特长|清单)?$|^证书(?:荣誉)?$|^获奖(?:情况|经历)$/u.test(value))return 'skills';
  if (/^(?:校园|社团|实习|工作|项目|实践|科研|研究|志愿|竞赛)(?:与项目)?(?:经历|经验|活动|服务)$|^社会实践$/u.test(value))return 'experience';
  return undefined;
}
// A year such as 2025.03 starts a role/date heading, not a numbered bullet.
const bullet=/^[\s●•▪◆◇■*\-]|^\d{1,2}[、.)）](?!\d)/u;
const action=/^(?:我|本人|负责|参与|协助|完成|通过|使用|运用|采用|基于|聚焦|构建|统筹|带队|组织|策划|梳理|研究|收集|整理|获得|带领|在该|该项目)/u;
function experienceHeading(line:Line,next:Line|undefined):boolean {
  const value=line.text.trim();
  if(bullet.test(value)||value.length>180)return false;
  if(/^20\d{2}(?:\s*[年./-]\s*\d{1,2}月?)?/u.test(value)&&/[\t|｜]|\s{2,}/u.test(value))return true;
  if(action.test(value)||/[。！？]/u.test(value))return false;
  if(/(?:项目|研究|论文|实习生|课程设计|志愿者|组长|干事|负责人|参赛选手|工程师|助理|大赛)/u.test(value)
    && (/[|｜\t]/u.test(value)||!!next&&bullet.test(next.text)))return true;
  return false;
}
function sourceLines(source:string):Line[] {
  const lines:Line[]=[];let blankBefore=false;
  for(const match of source.matchAll(/[^\r\n]+/gu)) {
    const text=match[0].trim();if(!text)continue;
    const start=match.index!+match[0].indexOf(text),end=start+text.length;
    blankBefore=!!lines.length&&/\n[ \t\r]*\n/u.test(source.slice(lines.at(-1)!.end,start));
    lines.push({text,start,end,blankBefore});
  }
  return lines;
}

/** Project/role headings are hard boundaries. A previous paragraph never absorbs the next identity. */
export function semanticFactSources(source:string):SemanticFactSource[] {
  const lines=sourceLines(source);const groups:Array<Omit<SemanticFactSource,'id'|'source'>>=[];
  let kind:FactSourceKind='unknown';let sectionTitle='';let current:{start:number;end:number;title:string;kind:FactSourceKind}|undefined;
  const flush=()=>{if(current){groups.push({...current,text:source.slice(current.start,current.end)});current=undefined;}};
  for(let index=0;index<lines.length;index++) {
    const line=lines[index],next=lines[index+1];const section=sectionKind(line.text);
    if(section){flush();kind=section;sectionTitle=line.text;current={start:line.start,end:line.end,title:line.text,kind};continue;}
    const heading=kind!=='metadata'&&kind!=='education'&&experienceHeading(line,next);
    const independentBullet=(kind==='skills'||kind==='summary')&&bullet.test(line.text);
    const unknownParagraph=kind==='unknown'&&line.blankBefore&&!current?.title;
    if(heading){
      // Attach an otherwise empty section title to the first experience, but never
      // carry its last sentence over to the next dated header.
      if(current?.title===sectionTitle&&current.start===current.end-sectionTitle.length){current.title=line.text;current.kind='experience';current.end=line.end;}
      else {flush();current={start:line.start,end:line.end,title:line.text,kind:'experience'};}
    }else if(independentBullet&&current&&current.end!==current.start+sectionTitle.length){flush();current={start:line.start,end:line.end,title:sectionTitle,kind};}
    else if(unknownParagraph){flush();current={start:line.start,end:line.end,title:'',kind};}
    else if(current)current.end=line.end;
    else current={start:line.start,end:line.end,title:kind==='experience'?'':sectionTitle,kind};
  }
  flush();
  const result:SemanticFactSource[]=[];
  for(const group of groups) {
    // Only unusually long single experiences are split, always within that same
    // experience. The exact title is retained separately as grounded context.
    let start=group.start;
    while(start<group.end){
      let end=Math.min(group.end,start+2800);
      if(end<group.end){
        const candidate=source.slice(start,end);const boundary=Math.max(candidate.lastIndexOf('\n\n'),candidate.lastIndexOf('。')+1,candidate.lastIndexOf('\n'));
        if(boundary>400)end=start+boundary;
      }
      const value=source.slice(start,end);const text=value.trim();
      if(text){const exactStart=start+value.indexOf(text);result.push({id:`source_${result.length+1}`,text,source:group.text,title:group.title,kind:group.kind,start:exactStart,end:exactStart+text.length,...(group.title&&start!==group.start?{sourceContext:group.title}:{})});}
      start=end;
    }
  }
  return result;
}
