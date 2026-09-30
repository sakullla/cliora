import assert from 'node:assert/strict';

export async function verifyEditorGeometry(page, editor, label) {
  await editor.focus();
  await editor.press('Control+Home');
  await page.waitForTimeout(150);
  const geometry = await editor.evaluate(content => {
    const root = content.closest('.cm-editor');
    const scroller = root.querySelector('.cm-scroller');
    const line = content.querySelector('.cm-line');
    const cursor = root.querySelector('.cm-cursor');
    const rect = element => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return {x:value.x,y:value.y,width:value.width,height:value.height,bottom:value.bottom,right:value.right};
    };
    return {
      editor: {rect:rect(root),position:getComputedStyle(root).position},
      scroller: {rect:rect(scroller),display:getComputedStyle(scroller).display,position:getComputedStyle(scroller).position},
      line:rect(line),cursor:rect(cursor),
      layers:[...root.querySelectorAll('.cm-layer')].map(layer => ({class:layer.className,position:getComputedStyle(layer).position,rect:rect(layer)})),
      styleNonceAnchorPresent:!!document.getElementById('cliora-editor-nonce')?.nonce,
      dynamicStyles:[...document.head.querySelectorAll('style')].map(style => ({id:style.id,noncePresent:!!style.nonce,sheetPresent:!!style.sheet,rules:style.sheet?.cssRules.length ?? 0,hasCodeMirrorBaseRules:style.textContent.includes('.cm-layer')})),
      documentOverflow:document.scrollingElement.scrollWidth > innerWidth + 1 || document.scrollingElement.scrollHeight > innerHeight + 1,
    };
  });
  assert(geometry.styleNonceAnchorPresent, label+': Tauri style nonce anchor required');
  assert.equal(geometry.editor.position,'relative',label+': CM base positioning');
  assert.equal(geometry.scroller.display,'flex',label+': CM base scroller layout');
  assert(geometry.layers.length >= 2,label+': selection and cursor layers exist');
  assert(geometry.layers.every(layer => layer.position === 'absolute'),label+': selection layers absolute');
  assert(geometry.cursor && geometry.line,label+': visible cursor and first line');
  assert(Math.abs(geometry.cursor.y-geometry.line.y) < 5,label+': cursor aligns with first text line');
  assert(geometry.cursor.x >= geometry.line.x-2 && geometry.cursor.x <= geometry.line.x+8,label+': cursor starts in content after gutter');
  assert(!geometry.documentOverflow,label+': page has no outer scrollbar');
  return {name:'native-codemirror-layout',label,...geometry};
}
