import { describe, expect, it } from 'vitest';
import { globalCommand } from '../src/shortcuts';
describe('global shortcut mapping across keyboard layouts',()=>{
  it.each([['KeyS','ы',false,'save'],['KeyS','Ы',true,'saveAs'],['KeyO','щ',false,'open'],['KeyO','Щ',true,'folder'],['KeyN','т',false,'new'],['KeyF','а',false,'find'],['KeyH','р',false,'replace'],['Slash','/',false,'mode'],['Digit7','/',true,'mode'],['KeyM','M',true,'mode']])('maps %s with key %s', (code,key,shift,expected)=>{
    expect(globalCommand({code,key,ctrlKey:true,metaKey:false,altKey:false,shiftKey:shift} as KeyboardEvent)).toBe(expected);
  });
  it('leaves ordinary typing, AltGr and unrelated shortcuts alone',()=>{
    expect(globalCommand({code:'KeyS',key:'s',ctrlKey:false,metaKey:false,altKey:false} as KeyboardEvent)).toBeNull();
    expect(globalCommand({code:'KeyS',key:'ß',ctrlKey:true,altKey:true} as KeyboardEvent)).toBeNull();
    expect(globalCommand({code:'KeyB',key:'b',ctrlKey:true,shiftKey:false} as KeyboardEvent)).toBeNull();
  });
});
