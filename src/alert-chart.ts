import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { Chart, ChartConfiguration } from 'chart.js/auto';
import { color } from 'chart.js/helpers';
import moment from 'moment-timezone';
import Canvas from 'canvas';
import { CloudWatch } from 'aws-sdk';
import Stream from 'stream';
import 'chartjs-adapter-moment';

const localTimezone = 'Australia/Sydney';
moment.tz.setDefault(localTimezone);

['CanvasRenderingContext2D', 'CanvasPattern', 'CanvasGradient'].forEach((obj) => {
  (global as any)[obj] = (Canvas as any)[obj];
});

type AlarmState = 'OK' | 'Alarm' | 'Insufficient';

type GenerateGraphOptionsThreshold = 'lt' | 'gt' | 'gte' | 'lte' | 'eq';

const defaultPeriod = 300;

const colors = {
  orange: 'rgb(255, 127, 80)',
  red: 'rgb(255, 99, 132)',
  red05: 'rgba(255, 99, 132, 0.5)',
  blue: 'rgb(54, 162, 235)',
};

interface DateValueXY {
  x: Date;
  y: number;
}

export interface GenerateGraphOptions {
  title?: string;
  chartWidth?: number;
  chartHeight?: number;
  alarmStates?: {
    time: Date;
    /** Time which the state change begins (e.g. start of a series of intervals that led to state change) */
    beginTime?: Date;
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

function getCanvasRenderingService(width: number, height: number): ChartJSNodeCanvas {
  const canvasRenderService = new ChartJSNodeCanvas({
    width,
    height,
    chartCallback: (ChartJS) => {
      ChartJS.defaults.color = 'black';
      ChartJS.defaults.font.family = 'Arial';
      ChartJS.register([
        {
          id: 'alertChartCustom',
          beforeInit: (chartInstance: Chart) => {
            const thresholdPattern = chartInstance.ctx.createPattern(getThresholdAreaPattern() as any, 'repeat');
            const configuration = chartInstance.config;
            if (configuration.data && configuration.data.datasets) {
              (configuration.data.datasets[1] as any).backgroundColor = thresholdPattern;
            }
          },
          beforeDraw: (chartInstance: Chart) => {
            chartInstance.ctx.fillStyle = 'white';
            chartInstance.ctx.fillRect(0, 0, chartInstance.width, chartInstance.height);
          },
        } as any,
      ]);
    },
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

  if (!alarms.MetricAlarms?.length) throw new Error(`Alarm ${alarmName} not found in ${region}.`);

  const alarm = alarms.MetricAlarms[0];
  // console.log(alarm);
  if (!alarm.MetricName || !alarm.Namespace || !alarm.Statistic) {
    throw new Error(`Alarm ${alarmName} MetricName, Namespace or Statistic is not defined.`);
  }

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

  // console.log(startTime.toDate());

  // console.log(alarmHistory.AlarmHistoryItems);

  const alarmStates = alarmHistory.AlarmHistoryItems?.map((historyItem) => {
    const data = JSON.parse(historyItem.HistoryData || '{}');
    // console.log(data);
    const oldStateStartDate = data.oldState?.stateReasonData?.startDate
      ? moment(data.oldState.stateReasonData.startDate)
      : undefined;
    const stateStartDate = data.newState?.stateReasonData?.startDate
      ? moment(data.newState.stateReasonData.startDate)
      : undefined;

    if (
      oldStateStartDate &&
      stateValueMap[data.oldState?.stateValue] === 'Alarm' &&
      startTime.toDate().getTime() > oldStateStartDate.toDate().getTime()
    ) {
      // show all the way back to when the alarm was raised
      const samples =
        (endTime.toDate().getTime() - oldStateStartDate.toDate().getTime()) / (alarm.Period || defaultPeriod);
      if (samples < 1440) {
        startTime = oldStateStartDate;
      }
    } else if (stateStartDate && startTime.toDate().getTime() > stateStartDate.toDate().getTime()) {
      startTime = stateStartDate;
    }

    return {
      time: historyItem.Timestamp || new Date(),
      beginTime: stateStartDate?.toDate(),
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
    period: alarm.Period || defaultPeriod,
  });

  result.alarmStates = alarmStates;
  result.title = `${alarmName} - ${result.title}`;
  result.startTime = startTime.toDate();
  result.endTime = endTime.toDate();

  return result;
}

function getAlarmStateData(options: GenerateGraphOptions) {
  const alarmStateData: DateValueXY[] = [];
  const alarmBeginStateData: DateValueXY[] = [];
  if (options.alarmStates) {
    let lastState: AlarmState = 'OK';
    const startTime = options.startTime || options.points[0]?.time;
    let lastTime = startTime;

    for (const state of options.alarmStates) {
      if (startTime === undefined || state.time >= startTime) {
        if (alarmStateData.length === 0) {
          alarmStateData.push({ x: startTime, y: lastState === 'Alarm' ? 1 : NaN });
        }
        if (alarmBeginStateData.length === 0) {
          alarmBeginStateData.push({ x: startTime, y: lastState === 'Alarm' ? 1 : NaN });
        }

        if (state.newState === 'Alarm') {
          alarmStateData.push({ x: state.time, y: 1 });
          alarmBeginStateData.push({ x: state.beginTime || state.time, y: 1 });
        }

        if (state.newState === 'OK') {
          if (lastState === 'Alarm') {
            alarmStateData.push({ x: new Date(state.time.getTime() - 1), y: 1 });
            alarmBeginStateData.push({ x: new Date((state.beginTime || state.time).getTime() - 1), y: 1 });
          }
          alarmStateData.push({ x: state.time, y: NaN });
          alarmBeginStateData.push({ x: state.beginTime || state.time, y: NaN });
        }
      }

      lastTime = state.time;
      lastState = state.newState;
    }

    alarmStateData.push({ x: options.endTime || lastTime, y: lastState === 'Alarm' ? 1 : NaN });
    alarmBeginStateData.push({ x: options.endTime || lastTime, y: lastState === 'Alarm' ? 1 : NaN });
  }
  return { alarmStateData, alarmBeginStateData };
}

export async function generateGraph(
  options: GenerateGraphOptions,
): Promise<{ stream?: Stream; buffer?: Buffer; dataUri?: string }> {
  const labels = options.points.map((point) => point.time);

  const { alarmStateData, alarmBeginStateData } = getAlarmStateData(options);

  // console.log(options);
  // console.log(alarmStateData);
  // console.log(alarmBeginStateData);

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

  const configuration: ChartConfiguration = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          type: 'line',
          label: options.pointsLabel,
          tension: 0,
          backgroundColor: color(colors.red).alpha(0).rgbString(),
          borderColor: colors.blue,
          data: options.points.map((point) => point.value),
          yAxisID: 'yDefault',
        },
        {
          type: 'line',
          label: 'Threshold',
          borderColor: colors.red,
          fill: thresholdFill,
          borderWidth: 2,
          pointRadius: 0,
          data:
            options.alarmThresholdValue !== undefined
              ? Array(options.points.length).fill(options.alarmThresholdValue)
              : [],
          yAxisID: 'yDefault',
        },
        {
          type: 'line',
          label: 'Alarm Notification',
          backgroundColor: color(colors.red).alpha(0.3).rgbString(),
          borderWidth: 0,
          borderColor: colors.red,
          pointRadius: 0,
          tension: 0,
          fill: 'start',
          yAxisID: 'yAlarm',
          data: alarmStateData as any,
        },
        {
          type: 'line',
          label: 'Alarm Actual',
          backgroundColor: color(colors.orange).alpha(0.3).rgbString(),
          borderWidth: 0,
          borderColor: colors.red,
          pointRadius: 0,
          tension: 0,
          fill: 'start',
          yAxisID: 'yAlarmActual',
          data: alarmBeginStateData as any,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: !!options.title,
          text: options.title,
        },
      },
      scales: {
        yDefault: {
          display: true,
          ticks: {
            callback: (num) => num.toLocaleString('en'),
          },
          suggestedMin,
          suggestedMax,
        },
        yAlarm: {
          display: false,
          suggestedMin: 0,
          suggestedMax: 1,
        },
        yAlarmActual: {
          display: false,
          suggestedMin: 0,
          suggestedMax: 1,
        },
        x: {
          type: 'time',
          display: true,
          min: options.startTime,
          max: options.endTime,
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
        } as any,
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
