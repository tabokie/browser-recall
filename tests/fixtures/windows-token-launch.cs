using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Match the NSIS RunAsUser environment boundary without building or launching
// Browser Recall. A null environment builds the child's environment from the
// Windows user profile, rather than inheriting the parent's process variables.
public static class BrowserRecallTokenLaunch
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public short Show, ReservedSize;
        public IntPtr ReservedPointer, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public int ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges
    {
        public uint Count, LuidLow;
        public int LuidHigh;
        public uint Attributes;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")]
    private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeValue(string system, string name, out long luid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll,
        ref TokenPrivileges privileges, uint size, IntPtr previous, IntPtr returned);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr token, uint access,
        IntPtr attributes, int impersonationLevel, int tokenType, out IntPtr duplicate);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags,
        string application, StringBuilder command, uint flags, IntPtr environment,
        string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint code);

    private static Win32Exception Failure(string operation)
    {
        int error = Marshal.GetLastWin32Error();
        return new Win32Exception(error,
            operation + " failed (" + error + "): " + new Win32Exception(error).Message);
    }

    public static void Run(string executable, string script, string output)
    {
        IntPtr callerToken = IntPtr.Zero;
        IntPtr desktopProcess = IntPtr.Zero;
        IntPtr desktopToken = IntPtr.Zero;
        IntPtr primaryToken = IntPtr.Zero;
        var process = new ProcessInfo();
        try
        {
            // Request only QUERY | ADJUST_PRIVILEGES on the caller's token.
            // Do not request ASSIGN_PRIMARY on the runner's existing token.
            if (!OpenProcessToken(GetCurrentProcess(), 0x0028, out callerToken))
                throw Failure("OpenProcessToken(caller, QUERY | ADJUST_PRIVILEGES)");
            long luid;
            if (!LookupPrivilegeValue(null, "SeImpersonatePrivilege", out luid))
                throw Failure("LookupPrivilegeValue(SeImpersonatePrivilege)");
            var privileges = new TokenPrivileges {
                Count = 1, LuidLow = (uint)luid, LuidHigh = (int)(luid >> 32), Attributes = 2
            };
            if (!AdjustTokenPrivileges(callerToken, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero))
                throw Failure("AdjustTokenPrivileges(SeImpersonatePrivilege)");
            int privilegeError = Marshal.GetLastWin32Error();
            if (privilegeError != 0)
                throw new Win32Exception(privilegeError, "SeImpersonatePrivilege is unavailable on the Windows runner");

            // Match nsis_tauri_utils v0.5.3 RunAsUser: open the desktop user's
            // token with QUERY | DUPLICATE and create a separate primary token.
            // The runner's own primary token is not the installer's launch token.
            IntPtr window = GetShellWindow();
            if (window == IntPtr.Zero)
                throw new Exception("GetShellWindow: disposable interactive Windows desktop is unavailable");
            uint desktopProcessId;
            if (GetWindowThreadProcessId(window, out desktopProcessId) == 0)
                throw Failure("GetWindowThreadProcessId(desktop)");
            desktopProcess = OpenProcess(0x1000, false, desktopProcessId);
            if (desktopProcess == IntPtr.Zero)
                throw Failure("OpenProcess(desktop, QUERY_LIMITED_INFORMATION)");
            if (!OpenProcessToken(desktopProcess, 0x000A, out desktopToken))
                throw Failure("OpenProcessToken(desktop, QUERY | DUPLICATE)");
            // QUERY | ASSIGN_PRIMARY | DUPLICATE | ADJUST_DEFAULT | ADJUST_SESSIONID;
            // SecurityAnonymous (0), TokenPrimary (1), as used by the installer.
            if (!DuplicateTokenEx(desktopToken, 0x018B, IntPtr.Zero, 0, 1, out primaryToken))
                throw Failure("DuplicateTokenEx(desktop, TokenPrimary)");
            var startup = new StartupInfo();
            startup.Size = Marshal.SizeOf(startup);
            var command = new StringBuilder("\"" + executable + "\" \"" + script + "\" \"" + output + "\"");
            if (!CreateProcessWithTokenW(primaryToken, 0, executable, command, 0x08000000,
                IntPtr.Zero, null, ref startup, out process))
                throw Failure("CreateProcessWithTokenW(desktop primary token)");
            if (WaitForSingleObject(process.Process, 10000) != 0)
            {
                TerminateProcess(process.Process, 1);
                WaitForSingleObject(process.Process, 5000);
                throw new Exception("Token-launched environment probe did not exit");
            }
            uint code;
            if (!GetExitCodeProcess(process.Process, out code))
                throw Failure("GetExitCodeProcess(environment probe)");
            if (code != 0) throw new Exception("Token-launched environment probe failed: " + code);
        }
        finally
        {
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
            if (desktopToken != IntPtr.Zero) CloseHandle(desktopToken);
            if (desktopProcess != IntPtr.Zero) CloseHandle(desktopProcess);
            if (callerToken != IntPtr.Zero) CloseHandle(callerToken);
        }
    }
}
