{{- define "aura-relay.ns" -}}
{{- .Values.namespaceOverride | default .Release.Namespace -}}
{{- end -}}
{{- define "aura-relay.labels" -}}
app.kubernetes.io/name: aura-relay
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
