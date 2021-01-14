# alert-chart

Generate charts server-side for AWS Cloudwatch alarms and metrics.

## Install

```bash
$ yarn add alert-chart
```

## Example

```js
import fs from 'fs';
import { getAWSCloudWatchAlarmGraphOptions, generateGraph } from './alert-chart';

(async () => {
  const options = await getAWSCloudWatchAlarmGraphOptions('us-east-1', 'MyTestAlarm');
  const { stream } = await generateGraph(options);
  if (stream) {
    const outStream = fs.createWriteStream('test-alarm-chart.png');
    stream.pipe(outStream, { end: true });
  }
})();
```
