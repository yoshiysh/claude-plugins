// JSON.stringify は Error の message と stack を落とすので、失敗の原因を文字列で残す。
function failure(error) {
  const cause = error?.cause instanceof Error ? error.cause : error;
  return {failureType:error?.failureType,message:String(cause?.stack ?? cause?.message ?? error?.cause ?? error)};
}

export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type === 'test:fail') yield `${JSON.stringify({...event,data:{...event.data,details:{...event.data.details,error:failure(event.data.details?.error)}}})}\n`;
    else if (['test:enqueue', 'test:start', 'test:stdout', 'test:stderr', 'test:diagnostic', 'test:pass', 'test:complete', 'test:coverage', 'test:summary'].includes(event.type)) yield `${JSON.stringify(event)}\n`;
  }
}
