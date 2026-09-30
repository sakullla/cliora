import assert from 'node:assert/strict';

async function selection(editor) {
  return editor.evaluate(element => {
    const view=element.cmTile?.root?.view;
    if(!view)throw new Error('Actual native CodeMirror view required');
    const range=view.state.selection.main;
    return {from:range.from,to:range.to,text:view.state.sliceDoc(range.from,range.to),doc:view.state.doc.toString(),rectangles:element.closest('.code-editor').querySelectorAll('.cm-selectionBackground').length};
  });
}

export async function replaceEditorText(page, editor, value) {
  await editor.press('Control+a');
  await editor.press('Backspace');
  await page.keyboard.type(value.replace(/\r\n/g,'\n'));
}

export async function verifyPointerAndMenu(page, editor, label) {
  const fixture='# native mouse selection\nmodel = "selection-fixture"\nkeep = true\n';
  await replaceEditorText(page,editor,fixture);
  await editor.scrollIntoViewIfNeeded();
  await editor.press('Control+Home');
  const point=async position=>editor.evaluate((element,position)=>{
    const view=element.cmTile.root.view;
    const coords=view.coordsAtPos(position);
    if(!coords)throw new Error('CodeMirror position not visible');
    return {x:coords.left+0.25,y:(coords.top+coords.bottom)/2};
  },position);
  const from=4,to=46;
  const start=await point(from),end=await point(to);
  await page.mouse.move(start.x,start.y);
  await page.mouse.down();
  await page.mouse.move(end.x,end.y,{steps:15});
  await page.mouse.up();
  await page.waitForTimeout(120);
  const dragged=await selection(editor);
  assert.equal(dragged.from,from,label+': pointer drag start');
  assert.equal(dragged.to,to,label+': pointer drag end');
  assert.equal(dragged.text,fixture.slice(from,to),label+': real multiline selected content');
  assert(dragged.rectangles>=2,label+': multiline selection painted');
  await page.mouse.click((start.x+end.x)/2,end.y,{button:'right'});
  const menu=page.getByRole('menu',{name:'编辑菜单',exact:true});
  await menu.waitFor();
  const items=await menu.getByRole('menuitem').allTextContents();
  assert.equal(items.length,6,label+': compact six-item shared edit menu');
  for(const name of ['撤销','重做','剪切','复制','粘贴','全选'])assert(items.some(item=>item.startsWith(name)),label+': '+name+' exists');
  assert(await menu.getByRole('menuitem',{name:/^复制/}).isEnabled(),label+': selected text can be copied');
  const bounds=await menu.boundingBox();const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  assert(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y+bounds.height<=viewport.height,label+': menu stays in viewport');
  await menu.getByRole('menuitem',{name:/^全选/}).click();
  const all=await selection(editor);assert.equal(all.text,fixture,label+': menu Select All selects document');
  await editor.press('End');
  await editor.press('Control+Home');
  await editor.press('Z');
  assert((await selection(editor)).doc.startsWith('Z#'),label+': editor typed input');
  const editPoint=await point(1);
  await page.mouse.click(editPoint.x,editPoint.y,{button:'right'});
  await menu.getByRole('menuitem',{name:/^撤销/}).click();
  assert.equal((await selection(editor)).doc,fixture,label+': menu Undo modifies actual document');
  await page.mouse.click(editPoint.x,editPoint.y,{button:'right'});
  await menu.getByRole('menuitem',{name:/^重做/}).click();
  assert((await selection(editor)).doc.startsWith('Z#'),label+': menu Redo modifies actual document');
  await page.mouse.click(editPoint.x,editPoint.y,{button:'right'});
  await page.keyboard.press('Escape');assert.equal(await menu.count(),0,label+': Escape dismisses menu');
  // Double-click uses real pointer selection rather than programmatic CM dispatch.
  const word=fixture.indexOf('selection-fixture')+1;
  await replaceEditorText(page,editor,fixture);const wordPoint=await point(word);
  await page.mouse.dblclick(wordPoint.x,wordPoint.y);
  const doubleClicked=await selection(editor);assert(doubleClicked.text.includes('selection'),label+': double click selects word at mouse position');
  return {name:label,result:'passed',pointerDrag:{from:dragged.from,to:dragged.to,selectedCharacters:dragged.text.length,paintedRectangles:dragged.rectangles},menu:{items:6,bounds,undo:true,redo:true,selectAll:true,escape:true},doubleClickSelectedWord:true,clipboardOperations:'Not exercised; existing system clipboard left untouched'};
}
