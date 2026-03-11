export class ApiResponse<T> {
    success: boolean;
    data: T;
    meta?: any;
    error?: any;
}