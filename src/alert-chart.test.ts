import fs from 'fs';
import {
  generateAWSCloudWatchAlarmGraph,
  generateGraph,
  GenerateGraphOptions,
  getAWSCloudWatchAlarmGraphOptions,
} from './alert-chart';

jest.setTimeout(30000);

const testRegion = 'us-east-1';
const testAlarm = 'TestAlarm';

test('generate chart buffer', async () => {
  const options: GenerateGraphOptions = {
    points: [
      { time: new Date(2020, 11, 10), value: 10 },
      { time: new Date(2020, 11, 11), value: 10 },
      { time: new Date(2020, 11, 12), value: 11 },
      { time: new Date(2020, 11, 13), value: 15 },
      { time: new Date(2020, 11, 14), value: 12 },
      { time: new Date(2020, 11, 15), value: 10 },
    ],
    pointsLabel: 'Test Value',
  };
  if (!options) return;
  const { buffer } = await generateGraph({ outputFormat: 'buffer', ...options });
  expect(buffer?.byteLength).toBeGreaterThan(10);
});

test('generate chart buffer with alarm', async () => {
  const options: GenerateGraphOptions = {
    points: [
      { time: new Date(2020, 11, 10), value: 10 },
      { time: new Date(2020, 11, 11), value: 10 },
      { time: new Date(2020, 11, 12), value: 11 },
      { time: new Date(2020, 11, 13), value: 15 },
      { time: new Date(2020, 11, 14), value: 12 },
      { time: new Date(2020, 11, 15), value: 10 },
    ],
    pointsLabel: 'Test Value',
    alarmThresholdValue: 12,
    alarmThresholdComparison: 'gt',
    alarmStates: [
      { newState: 'Alarm', oldState: 'OK', time: new Date(2020, 11, 12, 12, 0, 0) },
      { newState: 'OK', oldState: 'Alarm', time: new Date(2020, 11, 14, 12, 0, 0) },
    ],
  };
  if (!options) return;
  const { buffer } = await generateGraph({ outputFormat: 'buffer', ...options });
  expect(buffer?.byteLength).toBeGreaterThan(10);
});

test('generate chart stream from AWS CloudWatch alarm', async () => {
  const stream = await generateAWSCloudWatchAlarmGraph(testRegion, testAlarm);
  expect(stream).toBeDefined();
  if (!stream) return;
  const filename = `test${Date.now()}.png`;
  const outStream = fs.createWriteStream(filename);
  stream.pipe(outStream, { end: true });
  expect(fs.existsSync(filename)).toBeTruthy();
  fs.unlinkSync(filename);
});

test('generate chart buffer from AWS CloudWatch alarm', async () => {
  const options = await getAWSCloudWatchAlarmGraphOptions(testRegion, testAlarm);
  expect(options).toBeDefined();
  if (!options) return;
  const { buffer } = await generateGraph({ outputFormat: 'buffer', ...options });
  expect(buffer?.byteLength).toBeGreaterThan(10);
});
