export default async function* reporter(source) {
  for await (const event of source) {
    if (['test:enqueue', 'test:start', 'test:stdout', 'test:stderr', 'test:pass', 'test:fail', 'test:complete', 'test:coverage', 'test:summary'].includes(event.type)) yield `${JSON.stringify(event)}\n`;
  }
}
