import { CanvasRenderService } from 'chartjs-node-canvas';
import Chart from 'chart.js';
import moment from 'moment-timezone';
import Canvas from 'canvas';
import { CloudWatch } from 'aws-sdk';
import Stream from 'stream';

const localTimezone = 'Australia/Sydney';
moment.tz.setDefault(localTimezone);

['CanvasRenderingContext2D', 'CanvasPattern', 'CanvasGradient'].forEach((obj) => {
  (global as any)[obj] = (Canvas as any)[obj];
});

type AlarmState = 'OK' | 'Alarm' | 'Insufficient';

type GenerateGraphOptionsThreshold = 'lt' | 'gt' | 'gte' | 'lte' | 'eq';

const colors = {
  red: 'rgb(255, 99, 132)',
  red05: 'rgba(255, 99, 132, 0.5)',
  blue: 'rgb(54, 162, 235)',
};

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
  alarmThresholdComparison?: GenerateGraphOptionsThreshold;
  startTime?: Date;
  endTime?: Date;
  points: { time: Date; value: number }[];
  outputFormat?: 'stream' | 'buffer' | 'dataUri';
}

function getThresholdAreaPattern() {
  const canvas = Canvas.createCanvas(32, 32);
  const context = canvas.getContext('2d');
  context.strokeStyle = colors.red05;
  context.moveTo(32, 0);
  context.lineTo(0, 32);
  context.stroke();
  return canvas;
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

  // eslint-disable-next-line no-underscore-dangle
  const originalCreateCanvas: any = (canvasRenderService as any)._createCanvas;
  // eslint-disable-next-line no-underscore-dangle
  (canvasRenderService as any)._createCanvas = (...args: any[]) => {
    const canvas = originalCreateCanvas.apply(canvasRenderService, args);
    (canvasRenderService as any).overrideConfigurationWithCanvas?.(canvas);
    return canvas;
  };

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
  thresholdComparison?: GenerateGraphOptionsThreshold;
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
  thresholdComparison,
  region,
  startTime,
  endTime,
  period,
}: CloudWatchMetricGraphOptions): Promise<GenerateGraphOptions> {
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

  return {
    title: `${namespace} ${metricName} ${formatDimensions(dimensions)}`,
    alarmThresholdValue: threshold,
    alarmThresholdComparison: thresholdComparison,
    pointsLabel: data.Label || 'Metric',
    points: data.Datapoints
      ? data.Datapoints.map((point) => ({
          time: point.Timestamp || new Date(),
          value: (point as any)[statistic] !== undefined ? (point as any)[statistic] : NaN,
        })).sort(sortHelper((x) => x.time.getTime()))
      : [],
  };
}

const stateValueMap: { [key: string]: AlarmState } = {
  INSUFFICIENT_DATA: 'Insufficient',
  OK: 'OK',
  ALARM: 'Alarm',
};

function calculateAWSCloudWatchAlarmStartTime(endTime: moment.Moment, alarm: CloudWatch.MetricAlarm): moment.Moment {
  const idealDataPoints = 100;
  const day = 86400;
  let timespan = day;
  if (alarm.Period) {
    if (alarm.EvaluationPeriods && alarm.Period * alarm.EvaluationPeriods * 4 > day) {
      // show 4 times the evaluation periods, if greater than 1 day
      timespan = alarm.Period * alarm.EvaluationPeriods * 2;
    } else if (alarm.Period * idealDataPoints < day) {
      // show at most 100 data points
      timespan = alarm.Period * idealDataPoints;
    }
  }

  return moment(endTime).subtract(timespan, 'seconds');
}

/**
 *
 * @param region AWS region
 * @param alarmName name of AWS alarm
 * @param graphTimespan timespan in seconds to generate graph. Default is auto.
 */
export async function getAWSCloudWatchAlarmGraphOptions(
  region: string,
  alarmName: string,
  graphTimespan: number | undefined = undefined,
): Promise<GenerateGraphOptions> {
  const cloudWatch = new CloudWatch({ region });
  const alarms = await cloudWatch.describeAlarms({ AlarmNames: [alarmName] }).promise();
  // console.log(alarms);

  if (!alarms.MetricAlarms?.length) throw new Error(`Alarm name ${alarmName} not found`);

  const alarm = alarms.MetricAlarms[0];
  // console.log(alarm);
  if (!alarm.MetricName || !alarm.Namespace || !alarm.Statistic)
    throw new Error(`Alarm ${alarmName} MetricName, Namespace or Statistic is not defined`);

  const endTime = moment();
  // calculate start time
  let startTime = graphTimespan
    ? moment(endTime).subtract(graphTimespan, 'seconds')
    : calculateAWSCloudWatchAlarmStartTime(endTime, alarm);

  let thresholdComparison: GenerateGraphOptionsThreshold | undefined;
  switch (alarm.ComparisonOperator) {
    case 'GreaterThanThreshold':
      thresholdComparison = 'gt';
      break;
    case 'GreaterThanOrEqualToThreshold':
      thresholdComparison = 'gte';
      break;
    case 'LessThanThreshold':
      thresholdComparison = 'lt';
      break;
    case 'LessThanOrEqualToThreshold':
      thresholdComparison = 'lte';
      break;
    default:
  }

  const alarmHistory = await cloudWatch
    .describeAlarmHistory({
      AlarmName: alarmName,
      StartDate: startTime.toDate(),
      HistoryItemType: 'StateUpdate',
      ScanBy: 'TimestampAscending',
    })
    .promise();

  const alarmStates = alarmHistory.AlarmHistoryItems?.map((historyItem) => {
    const data = JSON.parse(historyItem.HistoryData || '{}');
    // console.log(data);
    const oldStateStartDate = data.oldState?.stateReasonData?.startDate
      ? moment(data.oldState.stateReasonData.startDate)
      : undefined;
    const stateStartDate = data.newState?.stateReasonData?.startDate
      ? moment(data.newState.stateReasonData.startDate)
      : undefined;

    if (oldStateStartDate && startTime.toDate().getTime() > oldStateStartDate.toDate().getTime()) {
      startTime = oldStateStartDate;
    } else if (stateStartDate && startTime.toDate().getTime() > stateStartDate.toDate().getTime()) {
      startTime = stateStartDate;
    }

    return {
      time: stateStartDate?.toDate() || historyItem.Timestamp || new Date(),
      oldState: stateValueMap[data.oldState.stateValue],
      newState: stateValueMap[data.newState.stateValue],
    };
  }).sort(sortHelper((x) => x.time.getTime()));

  const result = await getAWSCloudWatchMetricGraphOptions({
    metricName: alarm.MetricName,
    namespace: alarm.Namespace,
    statistic: alarm.Statistic,
    dimensions: alarm.Dimensions,
    threshold: alarm.Threshold,
    thresholdComparison,
    region,
    startTime: startTime.toDate(),
    endTime: endTime.toDate(),
    period: alarm.Period || 300,
  });

  result.alarmStates = alarmStates;
  result.title = `${alarmName} - ${result.title}`;
  result.startTime = startTime.toDate();
  result.endTime = endTime.toDate();

  return result;
}

export async function generateGraph(
  options: GenerateGraphOptions,
): Promise<{ stream?: Stream; buffer?: Buffer; dataUri?: string }> {
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

  let suggestedMax: number | undefined;
  let suggestedMin: number | undefined;
  let thresholdFill: string | false = false;
  const threadholdMargin = 0.1;
  if (options.alarmThresholdValue) {
    const pointMax = options.points.reduce(
      (accum, point) => (accum > point.value ? accum : point.value),
      Number.MIN_VALUE,
    );
    const pointMin = options.points.reduce(
      (accum, point) => (accum < point.value ? accum : point.value),
      Number.MAX_VALUE,
    );
    if (options.alarmThresholdComparison === 'gt' || options.alarmThresholdComparison === 'gte') {
      thresholdFill = 'end';
      if (pointMax <= options.alarmThresholdValue) {
        suggestedMax = options.alarmThresholdValue + (options.alarmThresholdValue - pointMin) * threadholdMargin;
      }
    } else if (options.alarmThresholdComparison === 'lt' || options.alarmThresholdComparison === 'lte') {
      thresholdFill = 'start';
      if (pointMin >= options.alarmThresholdValue) {
        suggestedMin = options.alarmThresholdValue - (pointMax - options.alarmThresholdValue) * threadholdMargin;
      }
    }
  }

  const configuration: Chart.ChartConfiguration = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          type: 'line',
          label: options.pointsLabel,
          lineTension: 0,
          backgroundColor: color(colors.red).alpha(0).rgbString(),
          borderColor: colors.blue,
          data: options.points.map((point) => point.value),
          yAxisID: 'default',
        },
        {
          type: 'line',
          label: 'Threshold',
          borderColor: colors.red,
          fill: thresholdFill,
          borderWidth: 2,
          radius: 0,
          data:
            options.alarmThresholdValue !== undefined
              ? Array(options.points.length).fill(options.alarmThresholdValue)
              : [],
        },
        {
          type: 'line',
          label: 'Alarm',
          backgroundColor: color(colors.red).alpha(0.4).rgbString(),
          borderWidth: 0,
          borderColor: colors.red,
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
            ticks: {
              callback: (num: number) => num.toLocaleString('en'),
              suggestedMin,
              suggestedMax,
            },
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

  // hack to get access to the canvas context so we could create a pattern
  (canvasRenderService as any).overrideConfigurationWithCanvas = (canvas: Canvas.Canvas) => {
    const thresholdPattern = canvas.getContext('2d').createPattern(getThresholdAreaPattern(), 'repeat');
    if (configuration.data && configuration.data.datasets) {
      configuration.data.datasets[1].backgroundColor = thresholdPattern;
    }
  };

  const stream = canvasRenderService.renderToStream(configuration);
  return { stream };
}
