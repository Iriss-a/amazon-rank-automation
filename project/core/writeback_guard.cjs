async function writeAndVerify({ read, write, expected }) {
  const before = await read();
  await write(expected);
  const after = await read();
  if (after !== expected) throw new Error(`RESULT_WRITE_VERIFY_FAILED:${after}`);
  return { before, after, verified: true };
}

module.exports = { writeAndVerify };
