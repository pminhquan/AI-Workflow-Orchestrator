$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# UI Automation reads the selected chat. PostMessage targets its renderer
# without activating the app or moving the system pointer.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AntigravityWindowInput {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    static string ClassName(IntPtr hwnd) {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }
    public static IntPtr[] Windows(int[] processIds) {
        var result = new List<IntPtr>();
        EnumWindows((hwnd, _) => {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (Array.IndexOf(processIds, (int)pid) >= 0 && IsWindowVisible(hwnd) &&
                GetWindow(hwnd, 4) == IntPtr.Zero && ClassName(hwnd) == "Chrome_WidgetWin_1") result.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    public static IntPtr[] Renderers(IntPtr parent) {
        var result = new List<IntPtr>();
        EnumChildWindows(parent, (hwnd, _) => {
            if (ClassName(hwnd) == "Chrome_RenderWidgetHostHWND") result.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    public static bool Click(IntPtr hwnd, int x, int y) {
        var point = new Point { X=x, Y=y };
        Rect rect;
        if (!ScreenToClient(hwnd, ref point) || !GetClientRect(hwnd, out rect) ||
            point.X < 0 || point.Y < 0 || point.X >= rect.Right || point.Y >= rect.Bottom ||
            point.X > 32767 || point.Y > 32767) return false;
        var position = (IntPtr)((point.Y << 16) | point.X);
        bool down = PostMessage(hwnd, 0x0201, (IntPtr)1, position);
        bool up = PostMessage(hwnd, 0x0202, IntPtr.Zero, position);
        return down && up;
    }
    public static bool Write(IntPtr hwnd, string value) {
        foreach (char ch in value) {
            if (!PostMessage(hwnd, 0x0102, (IntPtr)ch, (IntPtr)1)) return false;
        }
        return true;
    }
}
'@

$scope = [System.Windows.Automation.TreeScope]::Descendants
$nameProperty = [System.Windows.Automation.AutomationElement]::NameProperty
$typeProperty = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$editorName = [System.Windows.Automation.PropertyCondition]::new($nameProperty, 'Message input')
$sendName = [System.Windows.Automation.PropertyCondition]::new($nameProperty, 'Send message')
$buttons = [System.Windows.Automation.PropertyCondition]::new($typeProperty, [System.Windows.Automation.ControlType]::Button)

function Get-Composer($root) {
    $fields = $root.FindAll($scope, $editorName)
    if ($fields.Count -ne 1) { throw 'No unique Antigravity message input' }
    $field = $fields[0]
    if ($field.Current.IsOffscreen -or -not $field.Current.IsEnabled) { throw 'Message input is not visible and enabled' }
    return $field
}

function Get-ChatContext($root, $field, [string]$expected) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $document = $field
    while ($null -ne $document -and $document.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document) {
        $document = $walker.GetParent($document)
    }
    if ($null -eq $document) { throw 'Message input has no Antigravity document' }
    $names = @($document.FindAll($scope, $buttons) | ForEach-Object { $_.Current.Name })
    $models = @($names | Where-Object { $_ -like 'Select model, current: *' })
    $projects = @($names | Where-Object { $_ -like 'Select project, current: *' })
    if ($models.Count -ne 1 -or $projects.Count -gt 1) { throw 'Cannot identify the selected project and model' }
    $title = $document.Current.Name
    if ($projects.Count -eq 1) {
        $project = $projects[0].Substring('Select project, current: '.Length)
    } elseif ($expected -and $title.EndsWith(" - $expected - Antigravity", [StringComparison]::OrdinalIgnoreCase)) {
        $project = $expected
    } elseif ($title -match ' - ([^\r\n]+?) - Antigravity$') {
        $project = ($Matches[1] -split ' - ')[-1]
    } else {
        throw 'The current Antigravity project is unidentified'
    }
    if ($expected -and $project -ine $expected) { throw "Open Antigravity project is '$project', expected '$expected'" }
    $route = $document.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty)
    return @{ project_name = $project; selected_model = $models[0].Substring('Select model, current: '.Length); route = [string]$route; title = $title }
}

function Read-Composer($field) {
    return $field.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value.TrimEnd("`r", "`n")
}

function Send-Click($element, $renderer) {
    $rect = $element.Current.BoundingRectangle
    if ($rect.IsEmpty -or $element.Current.IsOffscreen -or -not $element.Current.IsEnabled) { return $false }
    return [AntigravityWindowInput]::Click($renderer, [int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
}

$result = @{ status = 'not_sent'; project_name = $null; selected_model = $null; pid = $null; foreground_unchanged = $null }
$clickedSend = $false
$foreground = [AntigravityWindowInput]::GetForegroundWindow()
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.mode -notin @('inspect', 'submit')) { throw 'Unsupported input mode' }
    if ($request.mode -eq 'submit' -and ($request.expected_project -isnot [string] -or [string]::IsNullOrWhiteSpace($request.expected_project) -or
        $request.prompt -isnot [string] -or [string]::IsNullOrWhiteSpace($request.prompt) -or $request.prompt.Length -gt 8000 -or
        $request.prompt -match '[\x00-\x1f\x7f]')) { throw 'A project name and a printable single-line prompt up to 8000 characters are required' }

    $processIds = @(Get-Process -Name Antigravity -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $windows = @([AntigravityWindowInput]::Windows([int[]]$processIds))
    if ($windows.Count -ne 1) { throw 'Open one Antigravity window to identify the target' }
    $window = $windows[0]
    $windowProcessId = [uint32]0
    $null = [AntigravityWindowInput]::GetWindowThreadProcessId($window, [ref]$windowProcessId)
    $result.pid = $windowProcessId
    if ([AntigravityWindowInput]::IsIconic($window)) { throw 'Antigravity is minimized' }
    $renderers = @([AntigravityWindowInput]::Renderers($window))
    if ($renderers.Count -ne 1) { throw 'No unique Antigravity renderer' }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    $field = Get-Composer $root
    $context = Get-ChatContext $root $field $request.expected_project
    $result.project_name = $context.project_name
    $result.selected_model = $context.selected_model
    $result.foreground_was_antigravity = $foreground -eq $window
    $draft = Read-Composer $field
    $result.draft_present = -not [string]::IsNullOrWhiteSpace($draft)

    if ($request.mode -eq 'inspect') {
        $result.status = 'ready'
    } else {
        if ($result.draft_present -and $draft -cne $request.prompt) { throw 'Existing draft was preserved' }
        if (-not $result.draft_present) {
            if (-not (Send-Click $field $renderers[0])) { throw 'Could not target the message input' }
            if (-not [AntigravityWindowInput]::Write($renderers[0], $request.prompt)) { throw 'Prompt input did not complete' }
            for ($i = 0; $i -lt 24; $i++) {
                Start-Sleep -Milliseconds 200
                $field = Get-Composer $root
                if ((Read-Composer $field) -ceq $request.prompt) { break }
            }
        }
        $field = Get-Composer $root
        if ((Read-Composer $field) -cne $request.prompt) { throw 'Prompt text was not confirmed in the composer' }
        $beforeSend = Get-ChatContext $root $field $request.expected_project
        $beforeWindows = @([AntigravityWindowInput]::Windows([int[]]$processIds))
        if ($beforeSend.route -cne $context.route -or $beforeSend.title -cne $context.title -or
            $beforeSend.selected_model -cne $context.selected_model -or
            $beforeWindows.Count -ne 1 -or $beforeWindows[0] -ne $window -or
            [AntigravityWindowInput]::GetForegroundWindow() -ne $foreground) { throw 'Chat, model or foreground changed before submit' }
        $send = $root.FindAll($scope, $sendName)
        if ($send.Count -ne 1 -or -not $send[0].Current.IsEnabled -or $send[0].Current.IsOffscreen) { throw 'Send button is unavailable' }
        $message = [System.Windows.Automation.PropertyCondition]::new($nameProperty, [string]$request.prompt)
        $clickedSend = $true
        if (-not (Send-Click $send[0] $renderers[0])) { throw 'Submit click could not be confirmed' }
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 200
            $field = Get-Composer $root
            if ([string]::IsNullOrWhiteSpace((Read-Composer $field)) -and $null -ne $root.FindFirst($scope, $message)) {
                $result.status = 'submitted'
                break
            }
        }
        if ($result.status -ne 'submitted') { throw 'Chat or queue did not confirm submission' }
    }
} catch {
    if ($clickedSend) { $result.status = 'uncertain' }
    $result.reason = $_.Exception.Message
}
$result.foreground_unchanged = $foreground -eq [AntigravityWindowInput]::GetForegroundWindow()
$result | ConvertTo-Json -Compress
