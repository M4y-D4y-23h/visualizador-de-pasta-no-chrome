# Abre o seletor de pastas moderno do Windows (o mesmo do Explorer) e devolve
# o caminho escolhido em base64 (UTF-8). Se o usuario cancelar, nao escreve nada.
#
# Variaveis de ambiente:
#   VISUALIZADOR_TITULO   titulo da janela
#   VISUALIZADOR_INICIAL  pasta exibida ao abrir (opcional)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SeletorDePastaVisualizador
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);

    private const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4;

    // Janela visivel deste processo com o titulo indicado.
    private static IntPtr ProcurarJanela(string titulo)
    {
        IntPtr achada = IntPtr.Zero;
        uint eu = (uint)Process.GetCurrentProcess().Id;
        EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid != eu || !IsWindowVisible(h)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.ToString() == titulo) { achada = h; return false; }
            return true;
        }, IntPtr.Zero);
        return achada;
    }

    private static void Log(string msg)
    {
        if (Environment.GetEnvironmentVariable("VISUALIZADOR_DEPURAR") == "1") Console.Error.WriteLine("[seletor] " + msg);
    }

    private static bool MesmoRetangulo(RECT a, RECT b)
    {
        return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
    }

    // Move a janela para o centro da area; devolve a posicao pretendida.
    private static RECT Centralizar(IntPtr h, int ax, int ay, int aw, int ah)
    {
        RECT r;
        GetWindowRect(h, out r);
        int w = Math.Min(r.Right - r.Left, aw);
        int hh = Math.Min(r.Bottom - r.Top, ah);
        bool mudaTamanho = w != r.Right - r.Left || hh != r.Bottom - r.Top;
        RECT alvo;
        alvo.Left = ax + (aw - w) / 2;
        alvo.Top = ay + (ah - hh) / 2;
        alvo.Right = alvo.Left + w;
        alvo.Bottom = alvo.Top + hh;
        SetWindowPos(h, IntPtr.Zero, alvo.Left, alvo.Top, w, hh, SWP_NOZORDER | (mudaTamanho ? 0 : SWP_NOSIZE));
        return alvo;
    }

    // O Windows posiciona novas janelas "em cascata" e o seletor pode acabar fora
    // da tela. Aqui ele e centralizado na area de trabalho do monitor onde esta o
    // mouse. Espera a posicao estabilizar (o proprio dialogo se reposiciona ao
    // abrir) e confere depois de mover.
    private static void CentralizarQuandoAbrir(string titulo, int ax, int ay, int aw, int ah)
    {
        Thread t = new Thread(delegate ()
        {
            try
            {
                Log("procurando janela [" + titulo + "] area=" + ax + "," + ay + " " + aw + "x" + ah);
                IntPtr h = IntPtr.Zero;
                for (int i = 0; i < 200 && h == IntPtr.Zero; i++)
                {
                    h = ProcurarJanela(titulo);
                    if (h == IntPtr.Zero) Thread.Sleep(50);
                }
                if (h == IntPtr.Zero) { Log("janela nao encontrada"); return; }

                // Somente para testes automatizados: tira a janela da area visivel, sem foco.
                if (Environment.GetEnvironmentVariable("VISUALIZADOR_TESTE") == "1")
                {
                    SetWindowPos(h, IntPtr.Zero, -20000, -20000, 0, 0, SWP_NOZORDER | SWP_NOSIZE);
                    return;
                }

                RECT anterior;
                GetWindowRect(h, out anterior);
                Log("encontrada em " + anterior.Left + "," + anterior.Top);
                for (int i = 0; i < 20; i++)
                {
                    Thread.Sleep(50);
                    RECT agora;
                    GetWindowRect(h, out agora);
                    if (i >= 3 && MesmoRetangulo(agora, anterior)) break;
                    anterior = agora;
                }

                for (int tentativa = 0; tentativa < 4; tentativa++)
                {
                    RECT alvo = Centralizar(h, ax, ay, aw, ah);
                    if (tentativa == 0) SetForegroundWindow(h);
                    Thread.Sleep(150);
                    RECT final;
                    GetWindowRect(h, out final);
                    Log("tentativa " + tentativa + ": alvo " + alvo.Left + "," + alvo.Top + " final " + final.Left + "," + final.Top);
                    if (MesmoRetangulo(final, alvo)) break;
                }
            }
            catch (Exception e)
            {
                Log("erro: " + e);
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogCoClass { }

    // IModalWindow::Show seguido dos metodos de IFileDialog, na ordem da vtable.
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

    private const uint FOS_NOCHANGEDIR = 0x8;
    private const uint FOS_PICKFOLDERS = 0x20;
    private const uint FOS_FORCEFILESYSTEM = 0x40;
    private const uint FOS_PATHMUSTEXIST = 0x800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int HR_CANCELLED = unchecked((int)0x800704C7);

    public static string Escolher(IntPtr dono, string titulo, string inicial, int ax, int ay, int aw, int ah)
    {
        if (String.IsNullOrEmpty(titulo)) titulo = "Escolha uma pasta";
        IFileDialog dlg = (IFileDialog)new FileOpenDialogCoClass();
        try
        {
            uint opts;
            dlg.GetOptions(out opts);
            dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
            dlg.SetTitle(titulo);
            dlg.SetOkButtonLabel("Selecionar pasta");
            if (!String.IsNullOrEmpty(inicial))
            {
                try
                {
                    IShellItem pasta;
                    SHCreateItemFromParsingName(inicial, IntPtr.Zero, typeof(IShellItem).GUID, out pasta);
                    dlg.SetFolder(pasta);
                }
                catch { }
            }
            CentralizarQuandoAbrir(titulo, ax, ay, aw, ah);
            int hr = dlg.Show(dono);
            if (hr == HR_CANCELLED) return null;
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);

            IShellItem resultado;
            dlg.GetResult(out resultado);
            IntPtr psz;
            resultado.GetDisplayName(SIGDN_FILESYSPATH, out psz);
            try { return Marshal.PtrToStringUni(psz); }
            finally { Marshal.FreeCoTaskMem(psz); }
        }
        finally
        {
            Marshal.ReleaseComObject(dlg);
        }
    }
}
'@

# Area de trabalho do monitor onde esta o mouse (onde o usuario acabou de clicar).
$area = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea

# Janela "dona" invisivel e sempre no topo: faz o seletor aparecer na frente do Chrome.
$dono = New-Object System.Windows.Forms.Form
$dono.TopMost = $true
$dono.ShowInTaskbar = $false
$dono.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$dono.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$dono.Size = New-Object System.Drawing.Size(1, 1)
$dono.Opacity = 0
$dono.Show()
if ($env:VISUALIZADOR_TESTE -ne '1') { $dono.Activate() }

try {
    $escolhida = [SeletorDePastaVisualizador]::Escolher($dono.Handle, $env:VISUALIZADOR_TITULO, $env:VISUALIZADOR_INICIAL,
        $area.X, $area.Y, $area.Width, $area.Height)
} finally {
    $dono.Close()
    $dono.Dispose()
}

if ($escolhida) {
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($escolhida)))
}
