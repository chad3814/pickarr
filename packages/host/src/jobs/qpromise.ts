export interface QPromise<T> extends Promise<T> {
    isPending: () => boolean;
    isResolved: () => boolean;
    isRejected: () => boolean;
}

export function makeQPromise<T>(promise: Promise<T> | QPromise<T>): QPromise<T> {
    let isPending = true;
    let isResolved = false;
    let isRejected = false;
    return Object.assign(promise.then(
        (v: T) => {
            isPending = false;
            isResolved = true;
            return v;
        },
        (e: unknown) => {
            isPending = false;
            isRejected = true;
            throw e;
        }
    ), {
        isPending: () => isPending,
        isResolved: () => isResolved,
        isRejected: () => isRejected
    });
}
