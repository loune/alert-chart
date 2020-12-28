import fs from 'fs';
import { generateAWSCloudWatchAlarmGraph, generateGraph, getAWSCloudWatchAlarmGraphOptions } from './alert-chart';

jest.setTimeout(30000);

const testRegion = 'us-east-1';
const testAlarm = 'TestAlarm';

test('generate chart', async () => {
  const stream = await generateAWSCloudWatchAlarmGraph(testRegion, testAlarm);
  expect(stream).toBeDefined();
  if (!stream) return;
  const filename = `test${Date.now()}.png`;
  const outStream = fs.createWriteStream(filename);
  stream.pipe(outStream, { end: true });
  expect(fs.existsSync(filename)).toBeTruthy();
  fs.unlinkSync(filename);
});

test('generate chart buffer', async () => {
  const options = await getAWSCloudWatchAlarmGraphOptions(testRegion, testAlarm);
  expect(options).toBeDefined();
  if (!options) return;
  const { buffer } = await generateGraph({ outputFormat: 'buffer', ...options });
  expect(buffer?.byteLength).toBeGreaterThan(10);
});
