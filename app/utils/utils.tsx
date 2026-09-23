import { useEffect, useRef } from "react";

export function shallowArrEq<A>(a: A[], b: A[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function shallowObjEq  (a: object, b: object) {
  return JSON.stringify(a) === JSON.stringify(b);
};
export function useWhyDidYouUpdate(name: string, deps: Record<string, any>) {
  const previousProps = useRef<Record<string, any>>({});
  
  useEffect(() => {
    const changedDeps: Record<string, { from: any; to: any }> = {};
    
    for (const key of Object.keys(deps)) {
      if (previousProps.current[key] !== deps[key]) {
        changedDeps[key] = {
          from: previousProps.current[key],
          to: deps[key],
        };
      }
    }
    
    if (Object.keys(changedDeps).length > 0) {
      console.log(`[${name}] Cambió:`, changedDeps);
    }
    
    previousProps.current = deps;
  });
}