// biome-ignore lint/suspicious/noExplicitAny: generic constraint requires any for function type compatibility
export function throttle<T extends (...args: any[]) => any>(func: T, limit: number): (...args: Parameters<T>) => void {
	let inThrottle: boolean;
	return function (this: unknown, ...args: Parameters<T>) {
		if (!inThrottle) {
			func.apply(this, args);
			inThrottle = true;
			setTimeout(() => (inThrottle = false), limit);
		}
	};
}
