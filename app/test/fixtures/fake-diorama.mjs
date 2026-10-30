// Stands in for bin/diorama.mjs in studio tests: prints the events a build step would, then exits.
const [cmd, slug] = process.argv.slice(2);
const emit = (type, data) => console.log(`@@diorama ${JSON.stringify({ type, ...data })}`);
if (cmd === 'sleep') await new Promise((r) => setTimeout(r, 10_000));
emit('step.start', { step: 'layout' });
console.log(`laying out ${slug} with key ${process.env.META_API_KEY}`);
emit('step.end', { step: 'layout', seconds: 0.1 });
if (cmd === 'face-warning') emit('step.end', {step:'faces',status:'incomplete',seconds:1,warnings:['wren: lips need review']});
if (cmd === 'fail' || process.env.FAKE_FAIL === '1') { console.error('diorama build: it broke'); process.exit(1); }
