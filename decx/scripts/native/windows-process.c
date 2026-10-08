/* Raw Windows command lines for already cmd-escaped .cmd/.bat arguments.
 * Linked into the scriptc executable; no Node or shell translation layer. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <limits.h>

static wchar_t *wide(const uint8_t *text, size_t size) {
    if (size > INT_MAX) return NULL;
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)text, (int)size, NULL, 0);
    if (count == 0 && size != 0) return NULL;
    wchar_t *result = (wchar_t *)calloc((size_t)count + 2, sizeof(wchar_t));
    if (!result) return NULL;
    if (count && !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)text, (int)size, result, count)) {
        free(result); return NULL;
    }
    return result;
}

static HANDLE inherited_handle(DWORD kind, DWORD access) {
    HANDLE result = INVALID_HANDLE_VALUE;
    HANDLE source = GetStdHandle(kind);
    if (source && source != INVALID_HANDLE_VALUE && DuplicateHandle(GetCurrentProcess(), source,
        GetCurrentProcess(), &result, 0, TRUE, DUPLICATE_SAME_ACCESS)) return result;
    SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
    return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, NULL);
}

/* "string" FFI parameters are UTF-8 pointer/length pairs, including env NULs.
 * Returns a child exit code, or negative Win32 error on setup/launch failure. */
double decx_windows_run(const uint8_t *app, size_t app_size,
    const uint8_t *line, size_t line_size, const uint8_t *environment, size_t environment_size,
    const uint8_t *out, size_t out_size, const uint8_t *err, size_t err_size, int32_t mode, int32_t hide) {
    wchar_t *application = wide(app, app_size), *command = wide(line, line_size);
    wchar_t *env = wide(environment, environment_size), *stdout_path = wide(out, out_size), *stderr_path = wide(err, err_size);
    HANDLE handles[3] = { INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE };
    STARTUPINFOEXW startup; PROCESS_INFORMATION child;
    ZeroMemory(&startup, sizeof(startup)); ZeroMemory(&child, sizeof(child));
    startup.StartupInfo.cb = sizeof(startup);
    DWORD error = ERROR_NOT_ENOUGH_MEMORY;
    double result = 0;
    if (!application || !command || !env || !stdout_path || !stderr_path) goto cleanup;
    if (!wcschr(application, L'\\') && !wcschr(application, L'/') && !wcschr(application, L':')) {
        DWORD capacity = SearchPathW(NULL, application, L".exe", 0, NULL, NULL);
        if (!capacity) { error = GetLastError(); goto cleanup; }
        wchar_t *resolved = (wchar_t *)calloc((size_t)capacity + 1, sizeof(wchar_t));
        if (!resolved) goto cleanup;
        DWORD length = SearchPathW(NULL, application, L".exe", capacity + 1, resolved, NULL);
        if (!length || length > capacity) {
            error = length ? ERROR_INSUFFICIENT_BUFFER : GetLastError(); free(resolved); goto cleanup;
        }
        free(application); application = resolved;
    }
    if (wcslen(command) >= 32767) { error = ERROR_INVALID_PARAMETER; goto cleanup; }
    SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
    handles[0] = inherited_handle(STD_INPUT_HANDLE, GENERIC_READ);
    if (mode == 0) {
        handles[1] = inherited_handle(STD_OUTPUT_HANDLE, GENERIC_WRITE);
        handles[2] = inherited_handle(STD_ERROR_HANDLE, GENERIC_WRITE);
    } else {
        handles[1] = CreateFileW(stdout_path, GENERIC_WRITE, FILE_SHARE_READ, &security, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        handles[2] = CreateFileW(stderr_path, GENERIC_WRITE, FILE_SHARE_READ, &security, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    }
    for (int i = 0; i < 3; i++) if (handles[i] == INVALID_HANDLE_VALUE) { error = GetLastError(); goto cleanup; }
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
    startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(bytes);
    if (!startup.lpAttributeList) goto cleanup;
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) {
        error = GetLastError(); free(startup.lpAttributeList); startup.lpAttributeList = NULL; goto cleanup;
    }
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handles, sizeof(handles), NULL, NULL)) { error = GetLastError(); goto cleanup; }
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
    if (hide) { startup.StartupInfo.dwFlags |= STARTF_USESHOWWINDOW; startup.StartupInfo.wShowWindow = SW_HIDE; }
    if (!CreateProcessW(application, command, NULL, NULL, TRUE,
        CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, env, NULL, &startup.StartupInfo, &child)) {
        error = GetLastError(); goto cleanup;
    }
    if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) { error = GetLastError(); goto cleanup; }
    DWORD status;
    if (!GetExitCodeProcess(child.hProcess, &status)) { error = GetLastError(); goto cleanup; }
    result = (double)status; error = 0;
cleanup:
    if (child.hThread) CloseHandle(child.hThread);
    if (child.hProcess) CloseHandle(child.hProcess);
    if (startup.lpAttributeList) { DeleteProcThreadAttributeList(startup.lpAttributeList); free(startup.lpAttributeList); }
    for (int i = 0; i < 3; i++) if (handles[i] != INVALID_HANDLE_VALUE) CloseHandle(handles[i]);
    free(application); free(command); free(env); free(stdout_path); free(stderr_path);
    return error ? -(double)error : result;
}
