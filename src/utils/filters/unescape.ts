export const unescapeString = (str: string): string => str.replace(/\\"/g, '"').replace(/\\n/g, '\n');
