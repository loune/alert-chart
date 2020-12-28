import { CanvasRenderService } from 'chartjs-node-canvas';
import Chart from 'chart.js';
import moment from 'moment-timezone';
import canvas from 'canvas';
import { CloudWatch } from 'aws-sdk';
import Stream from 'stream';

const localTimezone = 'Australia/Sydney';
moment.tz.setDefault(localTimezone);

['CanvasRenderingContext2D', 'CanvasPattern', 'CanvasGradient'].forEach((obj) => {
  (global as any)[obj] = (canvas as any)[obj];
});

type AlarmState = 'OK' | 'Alarm' | 'Insufficient';

export interface GenerateGraphOptions {
  title?: string;
  chartWidth?: number;
  chartHeight?: number;
  alarmStates?: {
    time: Date;
    oldState: AlarmState;
    newState: AlarmState;
  }[];
  pointsLabel: string;
  alarmThresholdValue?: number;
  startTime?: Date;
  endTime?: Date;
  points: { time: Date; value: number }[];
  outputFormat?: 'stream' | 'buffer' | 'dataUri';
}

function getCanvasRenderingService(width: number, height: number): CanvasRenderService {
  const canvasRenderService = new CanvasRenderService(width, height, (ChartJS) => {
    ChartJS.defaults.global.defaultFontColor = 'black';
    ChartJS.defaults.global.defaultFontFamily = 'Arial';
    ChartJS.plugins.register({
      beforeDraw: (chartInstance: any) => {
        chartInstance.chart.ctx.fillStyle = 'white';
        chartInstance.chart.ctx.fillRect(0, 0, chartInstance.chart.width, chartInstance.chart.height);
      },
    });
  });

  return canvasRenderService;
}

function sortHelper<T>(selector: (obj: T) => number) {
  return (valueA: T, valueB: T) => {
    if (selector(valueA) < selector(valueB)) {
      return -1;
    }
    return selector(valueA) > selector(valueB) ? 1 : 0;
  };
}

function formatDimensions(dimensions: CloudWatch.Dimension[] | undefined) {
  const strings: string[] = [];

  if (!dimensions) return '';

  for (const dim of dimensions) {
    strings.push(dim.Name);
    strings.push('=');
    strings.push(dim.Value);
    strings.push(' ');
  }

  return strings.join('');
}

export interface CloudWatchMetricGraphOptions {
  region?: string;
  metricName: string;
  namespace: string;
  dimensions?: CloudWatch.Dimension[];
  statistic: string;
  threshold?: number;
  startTime: Date;
  endTime: Date;
  period: number;
}

export async function getAWSCloudWatchMetricGraphOptions({
  metricName,
  namespace,
  statistic,
  dimensions,
  threshold,
  region,
  startTime,
  endTime,
  period,
}: CloudWatchMetricGraphOptions): Promise<GenerateGraphOptions | undefined> {
  // console.log(arguments[0]);

  const cloudWatch = new CloudWatch({ region });
  const data = await cloudWatch
    .getMetricStatistics({
      MetricName: metricName,
      Namespace: namespace,
      Dimensions: dimensions,
      Period: period,
      StartTime: startTime,
      EndTime: endTime,
      Statistics: ['SampleCount', statistic],
    })
    .promise();

  if (!data.Datapoints) return undefined;

  return {
    title: `${namespace} ${metricName} ${formatDimensions(dimensions)}`,
    alarmThresholdValue: threshold,
    pointsLabel: data.Label || 'Metric',
    points: data.Datapoints.map((point) => ({
      time: point.Timestamp || new Date(),
      value: (point as any)[statistic] !== undefined ? (point as any)[statistic] : NaN,
    })).sort(sortHelper((x) => x.time.getTime())),
  };
}

const stateValueMap: { [key: string]: AlarmState } = {
  INSUFFICIENT_DATA: 'Insufficient',
  OK: 'OK',
  ALARM: 'Alarm',
};

export async function getAWSCloudWatchAlarmGraphOptions(
  region: string,
  alarmName: string,
): Promise<GenerateGraphOptions | undefined> {
  const cloudWatch = new CloudWatch({ region });
  const alarms = await cloudWatch.describeAlarms({ AlarmNames: [alarmName] }).promise();
  // console.log(alarms);

  if (!alarms.MetricAlarms?.length) return undefined;

  const alarm = alarms.MetricAlarms[0];
  // console.log(alarm);
  if (!alarm.MetricName || !alarm.Namespace || !alarm.Statistic) return undefined;

  const endTime = moment();
  const startTime = moment(endTime).subtract(4, 'days');

  const result = await getAWSCloudWatchMetricGraphOptions({
    metricName: alarm.MetricName,
    namespace: alarm.Namespace,
    statistic: alarm.Statistic,
    dimensions: alarm.Dimensions,
    threshold: alarm.Threshold,
    region,
    startTime: startTime.toDate(),
    endTime: endTime.toDate(),
    period: alarm.Period || 300,
  });

  if (!result) return undefined;

  const alarmHistory = await cloudWatch
    .describeAlarmHistory({
      AlarmName: alarmName,
      StartDate: startTime.toDate(),
      HistoryItemType: 'StateUpdate',
      ScanBy: 'TimestampAscending',
    })
    .promise();

  result.alarmStates = alarmHistory.AlarmHistoryItems?.map((historyItem) => {
    const data = JSON.parse(historyItem.HistoryData || '{}');
    return {
      time: historyItem.Timestamp || new Date(),
      oldState: stateValueMap[data.oldState.stateValue],
      newState: stateValueMap[data.newState.stateValue],
    };
  }).sort(sortHelper((x) => x.time.getTime()));

  result.title = `${alarmName} - ${result.title}`;
  result.startTime = startTime.toDate();
  result.endTime = endTime.toDate();

  return result;
}

export async function generateGraph(
  options: GenerateGraphOptions,
): Promise<{ stream?: Stream; buffer?: Buffer; dataUri?: string }> {
  const chartColors = {
    red: 'rgb(255, 99, 132)',
    blue: 'rgb(54, 162, 235)',
  };

  const { color } = Chart.helpers;

  const labels = options.points.map((point) => point.time);

  const alarmStateData: { x: Date; y: number }[] = [];
  if (options.alarmStates) {
    let lastState: AlarmState = 'OK';
    const startTime = options.startTime || options.points[0]?.time;
    let lastTime = startTime;

    for (const state of options.alarmStates) {
      if (startTime === undefined || state.time >= startTime) {
        if (alarmStateData.length === 0) {
          alarmStateData.push({ x: startTime, y: lastState === 'Alarm' ? 1 : NaN });
        }

        if (state.newState === 'Alarm') {
          alarmStateData.push({ x: state.time, y: 1 });
        }

        if (state.newState === 'OK') {
          if (lastState === 'Alarm') {
            alarmStateData.push({ x: new Date(state.time.getTime() - 1), y: 1 });
          }
          alarmStateData.push({ x: state.time, y: NaN });
        }
      }

      lastTime = state.time;
      lastState = state.newState;
    }

    alarmStateData.push({ x: options.endTime || lastTime, y: lastState === 'Alarm' ? 1 : NaN });
  }

  // console.log(alarmStateData);

  const configuration: Chart.ChartConfiguration = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          type: 'line',
          label: options.pointsLabel,
          lineTension: 0,
          backgroundColor: color(chartColors.red).alpha(0).rgbString(),
          borderColor: chartColors.blue,
          data: options.points.map((point) => point.value),
          yAxisID: 'default',
        },
        {
          type: 'line',
          label: 'Threshold',
          borderColor: chartColors.red,
          borderWidth: 2,
          radius: 0,
          fill: false,
          data:
            options.alarmThresholdValue !== undefined
              ? Array(options.points.length).fill(options.alarmThresholdValue)
              : [],
        },
        {
          type: 'line',
          label: 'Alarm',
          backgroundColor: color(chartColors.red).alpha(0.4).rgbString(),
          borderWidth: 0,
          borderColor: chartColors.red,
          radius: 0,
          lineTension: 0,
          fill: 'start',
          yAxisID: 'alarm',
          data: alarmStateData,
        },
      ],
    },
    options: {
      title: {
        display: !!options.title,
        text: options.title,
      },
      scales: {
        yAxes: [
          {
            id: 'default',
            display: true,
          },
          {
            id: 'alarm',
            display: false,
            ticks: {
              suggestedMin: 0,
              suggestedMax: 1,
            },
          },
        ],
        xAxes: [
          {
            type: 'time',
            display: true,
            ticks: {
              min: options.startTime,
              max: options.endTime,
            },
            time: {
              // format: timeFormat,
              // round: 'day'
              tooltipFormat: 'DD/MM HH:mm',
              displayFormats: {
                millisecond: 'DD/MM T HH:mm:ss.SSS',
                second: 'DD/MM T HH:mm:ss',
                minute: 'DD/MM T HH:mm',
                hour: 'DD/MM T HH:00',
              },
            },
          },
        ],
      },
    },
  };

  const canvasRenderService = getCanvasRenderingService(options.chartWidth || 800, options.chartHeight || 480);

  if (options.outputFormat === 'buffer') {
    const buffer = await canvasRenderService.renderToBuffer(configuration);
    return { buffer };
  }

  if (options.outputFormat === 'dataUri') {
    const dataUri = await canvasRenderService.renderToDataURL(configuration);
    return { dataUri };
  }

  const stream = canvasRenderService.renderToStream(configuration);
  return { stream };
}

export async function generateAWSCloudWatchAlarmGraph(region: string, alarmName: string): Promise<Stream | undefined> {
  const options = await getAWSCloudWatchAlarmGraphOptions(region, alarmName);
  if (!options) return undefined;
  // console.log(options);
  const { stream } = await generateGraph(options);
  return stream;
}
