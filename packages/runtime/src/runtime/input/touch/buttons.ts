import type { TouchScheme } from './scheme.ts';
export type TouchActionInput = { injectAction(action: string, payload?: unknown, down?: boolean): boolean };
/** Pointer-counted authored controls; releasing one finger never releases another. */
export class TouchButtons {
 readonly #input: TouchActionInput;
 readonly #held = new Map<string, Set<number>>();
 readonly #pointerAction = new Map<number, string>();
 readonly #controls: ReadonlyMap<string, {action:string;hold:boolean}>;
 constructor(input: TouchActionInput, scheme: TouchScheme) { this.#input=input; this.#controls=new Map(scheme.controls.map(c=>[c.id,{action:c.action??c.id,hold:c.hold===true}])); }
 press(pointer:number,control:string):void {
 if(this.#pointerAction.has(pointer)) return;
 const def=this.#controls.get(control); if(!def)return;
 if(def.hold)this.#holdFor(pointer,def.action);else this.#pulse(def.action);
 }
  #holdFor(pointer: number, action: string): void {
    let pointers = this.#held.get(action);
    if (!pointers) this.#held.set(action, (pointers = new Set()));
    pointers.add(pointer);
    this.#pointerAction.set(pointer, action);
    if (pointers.size === 1) this.#input.injectAction(action, undefined, true);
  }

  release(pointer: number): void {
    const action = this.#pointerAction.get(pointer);
    if (!action) return;
    this.#pointerAction.delete(pointer);
    const pointers = this.#held.get(action)!;
    pointers.delete(pointer);
    if (pointers.size === 0) {
      this.#held.delete(action);
      this.#input.injectAction(action, undefined, false);
    }
  }

  isPressed(control:string):boolean { return (this.#held.get(this.#controls.get(control)?.action ?? '')?.size ?? 0)>0; }
  reset():void { for(const action of this.#held.keys())this.#input.injectAction(action,undefined,false);this.#held.clear();this.#pointerAction.clear(); }
  #pulse(action: string): void {
    this.#input.injectAction(action, undefined, true);
    this.#input.injectAction(action, undefined, false);
  }
}
