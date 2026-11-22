$ErrorActionPreference = 'Stop'
$owners = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')

function Assert-Private($path) {
    if ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) {
        throw 'unsafe_install_directory'
    }
    $acl = if ([IO.Directory]::Exists($path)) {
        [IO.Directory]::GetAccessControl($path)
    } else {
        [IO.File]::GetAccessControl($path)
    }
    $sid = [Security.Principal.SecurityIdentifier]
    if ($acl.GetOwner($sid).Value -notin $owners) { throw 'unsafe_install_directory' }
    foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 0xD0156) -and
            $rule.IdentityReference.Value -notin $owners) { throw 'unsafe_install_directory' }
    }
}

function Agent-Directory {
    $path = $env:LOCALAPPDATA
    Assert-Private $path
    foreach ($part in 'Twiglane', 'agent', 'v2') {
        $path = [IO.Path]::Combine($path, $part)
        if (![IO.Directory]::Exists($path)) {
            if ($op -ne 'install') { return }
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($owner in $owners) {
                $sid = [Security.Principal.SecurityIdentifier]::new($owner)
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
            }
            [void][IO.Directory]::CreateDirectory($path, $acl)
        }
        Assert-Private $path
    }
    return $path
}

function Agent-Digest($path) {
    Assert-Private $path
    $stream = [IO.File]::OpenRead($path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

try {
    if ($op -ne 'probe') {
        $preamble = [Text.Encoding]::ASCII.GetBytes("twiglane-peer/1`n")
        $stdout = [Console]::OpenStandardOutput()
        $stdout.Write($preamble, 0, $preamble.Length)
        $stdout.Flush()
        $stdin = [Console]::OpenStandardInput()
        if ($stdin.ReadByte() -ne 71) { throw 'peer_unverified' }
    }
    $path = Agent-Directory
    if ($op -eq 'probe') {
        [Console]::WriteLine('system=Windows')
        $architecture = $env:PROCESSOR_ARCHITEW6432
        if (!$architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
        [Console]::WriteLine("architecture=$architecture")
        if (Get-Command git.exe -ErrorAction SilentlyContinue) {
            $git = & git.exe --version
            if (!$LASTEXITCODE) { [Console]::WriteLine("git=$git") }
        }
        if ($path) {
            $pointer = [IO.Path]::Combine($path, 'current.sha256')
            if ([IO.File]::Exists($pointer)) {
                Assert-Private $pointer
                if ([IO.FileInfo]::new($pointer).Length -eq 64) {
                    $current = [IO.File]::ReadAllText($pointer)
                    if ($current -cmatch '\A[0-9a-f]{64}\z') {
                        $agent = [IO.Path]::Combine($path, "twiglane-agent-v2-$current.exe")
                        if ([IO.File]::Exists($agent) -and (Agent-Digest $agent) -ceq $current) {
                            [Console]::WriteLine("digest=$current")
                        }
                    }
                }
            }
        }
        exit 0
    }
    if (!$path) { throw 'agent_missing' }
    $agent = [IO.Path]::Combine($path, "twiglane-agent-v2-$digest.exe")
    if ($op -eq 'connect') {
        if (![IO.File]::Exists($agent)) { throw 'agent_missing' }
        if ((Agent-Digest $agent) -cne $digest) { throw 'agent_digest_mismatch' }
        $command = [Diagnostics.ProcessStartInfo]::new()
        $command.FileName = $agent
        $command.Arguments = '--stdio'
        $command.UseShellExecute = $false
        $child = [Diagnostics.Process]::Start($command)
        try { $child.WaitForExit(); exit $child.ExitCode } finally { $child.Dispose() }
    }
    $pointer = [IO.Path]::Combine($path, 'current.sha256')
    $temp = [Guid]::NewGuid().ToString('N')
    $incoming = [IO.Path]::Combine($path, ".incoming-$temp.exe")
    $next = [IO.Path]::Combine($path, ".incoming-$temp.sha256")
    $stream = [IO.File]::Open($incoming, 'CreateNew', 'Write', 'None')
    try { $stdin.CopyTo($stream) } finally { $stream.Dispose() }
    if ((Agent-Digest $incoming) -cne $digest) { throw 'agent_digest_mismatch' }
    if (![IO.File]::Exists($agent)) {
        [IO.File]::Move($incoming, $agent)
    } elseif ((Agent-Digest $agent) -cne $digest) {
        [IO.File]::Replace($incoming, $agent, $null)
    }
    [IO.File]::WriteAllText($next, $digest, [Text.Encoding]::ASCII)
    if ([IO.File]::Exists($pointer)) {
        Assert-Private $pointer
        [IO.File]::Replace($next, $pointer, $null)
    } else {
        [IO.File]::Move($next, $pointer)
    }
    [Console]::WriteLine(('{{"installed":true,"agentSha256":"{0}"}}' -f $digest))
    exit 0
} catch {
    $reason = $_.Exception.Message
    if ($reason -notin 'unsafe_install_directory', 'agent_missing', 'agent_digest_mismatch', 'peer_unverified') {
        $reason = 'agent_' + $op + '_failed'
    }
    [Console]::Error.WriteLine(('{{"error":"{0}"}}' -f $reason))
    exit 2
} finally {
    foreach ($temporary in $incoming, $next) {
        if ($temporary) { [IO.File]::Delete($temporary) }
    }
}
