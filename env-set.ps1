# JAVA_HOME
$jdk = (Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory | Select -First 1).FullName
[Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk, 'User')

# MAVEN_HOME
$mvn = "$env:USERPROFILE\tools\apache-maven-3.9.16"
[Environment]::SetEnvironmentVariable('MAVEN_HOME', $mvn, 'User')

# Agregar al Path de usuario (sin sobrescribir lo existente)
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
$add  = '%JAVA_HOME%\bin;%MAVEN_HOME%\bin'
if ($path -notlike '*%JAVA_HOME%\bin*') {
    [Environment]::SetEnvironmentVariable('Path', "$path;$add", 'User')
}