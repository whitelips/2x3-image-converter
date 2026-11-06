# Cloudflare 이미지 중계 배포

대상 Worker: `https://2x3-image-relay.whitelips19.workers.dev/`

## 대시보드에서 붙여넣기

1. Cloudflare 대시보드에서 **Workers & Pages → 2x3-image-relay**를 엽니다.
2. 실제 이미지 요청 전에 Worker 설정의 **Observability / Workers Logs / Traces**를 비활성화합니다. Worker Cache도 비활성화 상태로 둡니다. 코드 편집만으로 플랫폼 로그 설정이 꺼지는 것은 아닙니다.
3. **Edit code**에서 기본 코드를 모두 지우고 [worker.js](./worker.js)의 **전체 내용**을 붙여넣습니다. 별도 라이브러리, API 키, 저장소 바인딩은 필요 없습니다.
4. **Deploy**를 누릅니다.
5. 위 Worker 주소를 열어 아래 응답을 확인합니다.

```json
{"service":"2x3-image-relay","version":1,"status":"ok"}
```

6. [변환기](https://whitelips.github.io/2x3-image-converter/)를 새로고침하고 이미지 URL 여러 개를 입력합니다. 한 장이면 이미지 파일, 여러 장이면 ZIP을 자동 다운로드합니다.

위 상태 응답은 코드 배포 여부만 확인합니다. 실제 중계는 변환기의 POST 요청에서 실행됩니다. 대시보드 Preview나 주소창에 `?url=...`을 붙여서 이미지 요청을 테스트하지 않습니다.

## 동작과 데이터 처리

- 브라우저는 원본 URL을 Worker 주소의 쿼리가 아닌 JSON POST 본문으로 전달합니다.
- `https://image.cdn.mnetplus.world`만 허용하며, 다른 호스트·HTTP·인증정보가 포함된 URL을 거부합니다. 최대 3회의 리다이렉트도 각각 같은 조건을 검사합니다.
- Worker는 GET으로 원본을 받아 바이트를 변경하지 않고 스트리밍합니다. 쿠키·인증 헤더·Referer를 원본 서버에 전달하지 않습니다. WebP, PNG, JPEG 응답만 반환합니다.
- 이미지 파일과 URL을 앱 로그, DB, 파일 저장소, Cache API에 저장하지 않습니다. 요청과 응답에 `no-store`를 적용합니다. 원본 CDN 자체의 기존 캐시를 삭제하거나 제어하는 것은 아닙니다.
- 전체 이미지를 Worker 메모리에 버퍼링하지 않습니다. 이미지 용량·해상도에 별도 상한을 두지 않으며 URL 메타데이터 크기만 제한합니다. 원본 응답이 시작되기까지 30초 제한을 두고, 큰 파일의 전송 시간에는 별도 고정 제한을 두지 않습니다.
- 실제 변환과 ZIP 생성은 사용자 브라우저에서 실행합니다. 파일 첨부는 Worker에 전송하지 않습니다.
- CORS는 `https://whitelips.github.io`만 허용합니다. 이것은 사용자 인증이 아닙니다. 브라우저 밖에서는 Origin을 위조할 수 있으며, 다른 사람이 엔드포인트를 호출해 무료 요청량을 소모할 가능성은 있습니다. 중계에서 이미지 목록·저장 파일을 제공하지는 않습니다.
- Cloudflare 인프라에서 원본 URL과 이미지 바이트를 처리합니다. 앱의 비저장 설계가 플랫폼의 운영·보안 메타데이터까지 전혀 남지 않는다는 보장은 아닙니다. 신규 Worker의 로그는 기본 활성화되므로 배포 설정도 확인해야 합니다.

## 코드로 배포 설정 관리

`wrangler.jsonc`는 같은 Worker에 배포할 때 사용할 설정입니다. 로그·트레이스·Worker Cache·Logpush를 끄고 저장소 바인딩을 만들지 않습니다. **대시보드에 JavaScript만 붙여넣을 때 이 설정 파일이 자동 적용되지는 않습니다.**

관리자는 Cloudflare OAuth 인증 후 이 저장소 루트에서 Wrangler의 `deploy --config relay/wrangler.jsonc`로 배포할 수 있습니다. 다른 Cloudflare 계정에 같은 이름의 Worker를 만들지 않도록 배포 계정을 먼저 확인합니다. API 키를 저장소나 채팅에 넣지 않습니다.

로컬 Vite 주소는 운영 Worker의 CORS 허용 대상이 아닙니다. 자동 브라우저 테스트는 중계 응답을 모의 처리하고, 실서비스 검증은 GitHub Pages에서 실행합니다.

공식 문서: [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Cache 설정](https://developers.cloudflare.com/workers/cache/configuration/), [Free 플랜 한도](https://developers.cloudflare.com/workers/platform/limits/).
