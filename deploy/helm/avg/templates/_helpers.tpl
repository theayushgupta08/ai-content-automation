{{- define "avg.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "avg.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "avg.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
app.kubernetes.io/name: {{ include "avg.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: avg
avg.io/env: {{ .Values.global.env | quote }}
{{- end -}}

{{/* usage: include "avg.selectorLabels" (dict "root" . "component" "api") */}}
{{- define "avg.selectorLabels" -}}
app.kubernetes.io/name: {{ include "avg.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* usage: include "avg.image" (dict "root" . "image" .Values.api.image) */}}
{{- define "avg.image" -}}
{{- $tag := coalesce .image.tag .root.Values.global.imageTag .root.Chart.AppVersion -}}
{{- if .root.Values.global.imageRegistry -}}
{{- printf "%s/%s:%s" .root.Values.global.imageRegistry .image.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "avg.secretName" -}}
{{- default (printf "%s-app" (include "avg.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "avg.configName" -}}
{{- printf "%s-config" (include "avg.fullname" .) -}}
{{- end -}}

{{- define "avg.apiServiceAccount" -}}
{{- if .Values.api.serviceAccount.create -}}{{ include "avg.fullname" . }}-api{{- else -}}default{{- end -}}
{{- end -}}

{{- define "avg.workerServiceAccount" -}}
{{- if .Values.worker.serviceAccount.create -}}{{ include "avg.fullname" . }}-worker{{- else -}}default{{- end -}}
{{- end -}}

{{- define "avg.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{/* envFrom shared by every workload */}}
{{- define "avg.envFrom" -}}
envFrom:
  - configMapRef:
      name: {{ include "avg.configName" . }}
  - secretRef:
      name: {{ include "avg.secretName" . }}
{{- end -}}

{{/* usage: include "avg.extraEnv" .Values.api.env */}}
{{- define "avg.extraEnv" -}}
{{- range $k, $v := . }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end -}}

{{- define "avg.securityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: false
runAsNonRoot: true
runAsUser: 10001
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
{{- end -}}
