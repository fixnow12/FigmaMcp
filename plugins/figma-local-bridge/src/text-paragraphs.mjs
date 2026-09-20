// Portable exact-range paragraph restoration; temporary styles never persist.
export async function applyExactParagraphRanges(figma,node,runs=[]){
 // Native paragraph setters expand to whole paragraphs. A temporary local
 // TextStyle applies to exact characters; deleting it retains resolved values.
 // Clearing textStyleId instead would discard the per-character paragraph value.
 const fields=['fontName','fontSize','lineHeight','letterSpacing','textCase','textDecoration','paragraphSpacing','paragraphIndent','listSpacing','textWrapStyle'];
 const createdStyleIds=[],removedStyleIds=[];
 for(const run of runs){
  const requested=['paragraphSpacing','paragraphIndent'].filter(field=>run[field]!==undefined);
  if(!requested.length)continue;
  const segments=node.getStyledTextSegments([...fields,'boundVariables'],run.start,run.end);
  for(const segment of segments){
   if(requested.every(field=>segment[field]===run[field]))continue;
   const values=Object.fromEntries(fields.filter(field=>segment[field]!==undefined).map(field=>[field,segment[field]]));
   for(const field of requested)values[field]=run[field];
   for(const field of ['leadingTrim','hangingPunctuation','hangingList'])if(node[field]!==undefined){if(typeof node[field]==='symbol')throw Error('Cannot preserve mixed '+field+' while applying paragraph range');values[field]=node[field];}
   await figma.loadFontAsync(values.fontName);
   const aliases=[];
   for(const [field,alias]of Object.entries(segment.boundVariables||{}))if(alias?.type==='VARIABLE_ALIAS'){
    const variable=await figma.variables.getVariableByIdAsync(alias.id);if(!variable)throw Error('Missing paragraph range variable '+alias.id);
    aliases.push([field,variable]);
   }
   const style=figma.createTextStyle();createdStyleIds.push(style.id);
   try{
    style.name='Временное сохранение интервала';
    for(const [field,value]of Object.entries(values))style[field]=value;
    // Rebinding the node after style removal makes Figma regenerate the old
    // paragraph-wide style. Keep aliases on the temporary style itself.
    for(const [field,variable]of aliases)style.setBoundVariable(field,variable);
    await node.setRangeTextStyleIdAsync(segment.start,segment.end,style.id);
   }finally{
    style.remove();removedStyleIds.push(style.id);
    if(await figma.getStyleByIdAsync(style.id)!==null)throw Error('Temporary paragraph style was not removed');
   }
   const observed=node.getStyledTextSegments([...requested,'boundVariables'],segment.start,segment.end);
   if(!observed.length||observed.some(part=>requested.some(field=>part[field]!==run[field])||aliases.some(([field,variable])=>part.boundVariables?.[field]?.id!==variable.id)))throw Error('Exact paragraph range verification failed');
  }
 }
 return {createdStyleIds,removedStyleIds};
}
