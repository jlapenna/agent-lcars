import { format, toDate } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

const VERSION_STRING = '[VI]{{inject}}[/VI]';

export const DATE = isNaN(new Date(VERSION_STRING).valueOf())
  ? undefined
  : new Date(VERSION_STRING);

export const BUILD_DATE = isNaN(new Date(VERSION_STRING).valueOf())
  ? toDate(new Date())
  : toDate(new Date(VERSION_STRING));
export const DATE_STRING = format(BUILD_DATE, 'yyyy-MM-dd HH:mm:ss');

export const DATE_STRING_LOCAL = format(
  toZonedTime(BUILD_DATE, 'America/Los_Angeles'),
  'yyyy-MM-dd HH:mm:ss',
);
