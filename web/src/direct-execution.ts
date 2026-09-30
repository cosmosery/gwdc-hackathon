// Store only public batch IDs and request IDs. Reuse after reload or a lost response.
export function directExecutionKey(storage:Pick<Storage,'getItem'|'setItem'>,batchId:string):string {
  const name='settle.direct-execution.'+batchId;
  const existing=storage.getItem(name);
  if(existing)return existing;
  const key=crypto.randomUUID();
  storage.setItem(name,key);
  return key;
}
