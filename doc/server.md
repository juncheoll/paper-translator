# 서버 운영 안내

번역·임베딩·Docling 서버는 독립 서비스입니다. 같은 장비에서 실행해도 됩니다. 이 안내는 기존 SSH 터널·nginx·Ollama를 삭제하거나 변경하지 않고 새 Docling 경로를 추가하는 예시입니다.

## 번역과 임베딩

Ollama 서버에 번역 모델과 `embeddinggemma`를 준비합니다. 사용자에게 번역 API 기본 주소, 임베딩 기본 주소, 각각의 모델명과 인증 정보를 전달합니다. 예를 들어 번역은 `https://papers.example.org/ollama/v1`, 임베딩은 `https://papers.example.org/ollama`로 같은 엔진을 사용할 수 있습니다.

확장은 번역에 `/chat/completions`, Ollama 임베딩에 `/api/embed`를 사용합니다. OpenAI 형식을 선택한 임베딩에는 `/embeddings`를 붙입니다. Ollama 모델 메타데이터 조회는 `/api/tags`이며, 조회가 불가능해도 실제 추론 요청은 별도로 수행합니다. 프록시는 경로와 인증 헤더를 올바르게 전달하고 추론 중 연결을 충분히 유지해야 합니다.

## Docling CPU 서비스

Linux 서버 예시입니다. 배포 ZIP의 `tools/`를 포함한 프로젝트 파일을 `/opt/papertranslator`에 복사합니다. 기존 Python 환경과 분리합니다.

```sh
sudo useradd --system --home /var/lib/papertranslator --create-home --shell /usr/sbin/nologin papertranslator
sudo install -d -o papertranslator -g papertranslator /var/lib/papertranslator/models /var/lib/papertranslator/cache
sudo install -d -m 700 /etc/papertranslator
python3.12 -m venv /opt/papertranslator/venv
/opt/papertranslator/venv/bin/python -m pip install --upgrade pip
/opt/papertranslator/venv/bin/python -m pip install torch==2.15.0 torchvision==0.29.2 --index-url https://download.pytorch.org/whl/cpu
/opt/papertranslator/venv/bin/python -m pip install -r /opt/papertranslator/tools/requirements-docling.txt
sudo -u papertranslator /opt/papertranslator/venv/bin/python /opt/papertranslator/tools/prepare_docling_server.py --artifacts /var/lib/papertranslator/models
```

고정 패키지의 wheel을 제공하는 Python·운영체제가 필요합니다. 모델 준비가 끝나면 네트워크 없이 추론할 수 있습니다. OCR·표 구조 복원·수식 생성은 끄고 레이아웃 영역만 CPU로 분석합니다. 페이지는 하나씩 처리하고 모델은 상주시킵니다.

`tools/docling-server.env.example`을 `/etc/papertranslator/docling.env`로 복사한 뒤 `PAPER_DOCLING_TOKEN`에 충분히 긴 무작위 비밀값을 넣고 소유자 root, 권한 600으로 둡니다. 예시 파일에는 키를 넣지 않습니다. 토큰을 코드·Git·공유 문서에 기록하지 마세요.

`tools/docling-server.service`를 `/etc/systemd/system/paper-docling.service`로 복사합니다. 경로와 서비스 계정을 실제 서버에 맞게 확인한 후 실행합니다.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now paper-docling
sudo systemctl status paper-docling --no-pager -l
sudo journalctl -u paper-docling -n 30 --no-pager
```

서비스는 기본적으로 `127.0.0.1:8876`에 바인딩하고 `--warmup`으로 먼저 모델을 준비합니다. nginx와 다른 장비라면 내부 주소로 바인딩하되 토큰·방화벽·`--allow-host 실제주소:포트`를 설정하세요. 기본적으로 loopback 외 바인딩은 토큰이 없으면 시작되지 않습니다. systemd 예제는 `--require-token`도 지정하므로 loopback 실행이어도 토큰을 비워두면 시작되지 않습니다.

## 인증 없이 실행

연구실망·VPN·nginx 접근 제한으로 사용자를 제한하는 경우, `--allow-unauthenticated`를 명시해 Bearer 토큰 없이 실행할 수 있습니다. 이 옵션은 환경 파일에 기존 토큰이 남아 있어도 인증을 사용하지 않습니다. `--require-token`과 동시에 사용할 수 없습니다. Host·Origin 검사와 업로드 제한은 유지되지만, 이 검사는 curl 등의 외부 클라이언트에 대한 사용자 인증을 대체하지 않습니다.

동봉한 기본 서비스는 토큰 인증을 사용합니다. 엔진 서버의 `/etc/systemd/system/paper-docling.service`에서 `ExecStart`의 `--require-token`을 `--allow-unauthenticated`로 바꾸세요. 기존 bind·allow-host·모델·캐시 경로는 유지합니다.

```sh
sudoedit /etc/systemd/system/paper-docling.service
sudo systemctl daemon-reload
sudo systemctl restart paper-docling
```

모델 준비 완료 후 인증 헤더 없이 `/v1/info`를 호출해 200을 확인합니다. 확장 설정의 Docling API 키도 비웁니다. nginx의 Authorization 전달 줄은 그대로 두어도 되며, 별도로 설정한 `auth_basic`이나 접근 제어는 해당 프록시 정책을 따릅니다. 환경 파일은 기존 서비스에서 읽고 있으므로 파일을 삭제할 필요가 없습니다. 공용 주소에 접근 제한이 없으면 외부 사용자도 분석·캐시 조회 API를 이용할 수 있습니다.

## nginx 연결

`tools/nginx-docling.conf.example`의 `location /docling/` 블록을 **기존 HTTPS server 블록 안에** 추가합니다. 예시는 모델 API가 같은 장비의 8876에서 실행되는 경우입니다. TLS 인증서·도메인 설정을 함께 확인하세요. 기존 80 포트 서비스나 기본 사이트를 불필요하게 켜지 않습니다.

```sh
sudo nginx -t
sudo systemctl reload nginx
```

프록시는 요청 Authorization을 그대로 전달하며 토큰 모드의 Docling 서비스가 이를 검증합니다. HTTPS 없이 공용 인터넷에 토큰을 전송하지 마세요. 방화벽/VPN으로 연구실 사용자를 제한할 수 있습니다. PDF 업로드 제한은 50 MiB, 최대 페이지 수는 500입니다. nginx 예시는 270초까지 기다립니다.

허용 Origin의 기본값은 이 배포의 Chrome 확장 ID입니다. 확장 ID가 달라지면 서비스 실행에 `--allow-origin chrome-extension://새ID`를 추가합니다. 토큰 모드에서는 같은 URL의 사용자라도 서버 토큰 검증을 거칩니다. 확장은 background에서 요청하므로 일반 웹 페이지에 대한 무제한 CORS 허용은 필요하지 않습니다.

## 토큰 인증 오류 확인

토큰 모드의 요청 헤더에는 예시 문구가 아닌 `PAPER_DOCLING_TOKEN`의 실제 값을 넣습니다. 토큰은 `openssl rand -hex 32`처럼 영문·숫자로 생성하세요. 오류가 있는 인증 헤더에는 401을 반환하며, Host·Origin이 허용되지 않으면 403을 반환합니다.

엔진 서버에서는 토큰을 화면이나 셸 기록에 복사하지 않고 설정 파일에서 읽어 확인할 수 있습니다. 아래 주소는 실제 서비스 바인딩 주소로 맞춥니다.

```sh
sudo bash -c '
. /etc/papertranslator/docling.env
curl --noproxy "*" -sS -i --max-time 10 \
  -H "Authorization: Bearer $PAPER_DOCLING_TOKEN" \
  http://127.0.0.1:8876/v1/info
'
```

`Empty reply from server`는 HTTP 응답 없이 연결이 종료된 경우입니다. Docling 엔진 서버에서 `sudo journalctl -u paper-docling -n 60 --no-pager`로 요청 처리 예외를 확인하세요. nginx 502가 함께 발생하더라도 먼저 직접 엔진 연결을 확인합니다.

## 점검과 운영

선택한 인증 방식에 맞는 클라이언트로 `/docling/v1/info`가 schema 1, CPU, batch_size 1을 반환하는지 확인합니다. 사용자 설정에는 `https://papers.example.org/docling`과 같은 기본 주소만 입력합니다. 서버 모드에서 로컬 Native 도우미를 시작하지 않아야 합니다.

PDF 전체를 메모리에서 읽고 한 문서씩 분석합니다. 동시 요청이 많아지면 대기·시간 초과가 발생할 수 있으므로 베타에서는 소수 사용자로 시작해 처리 시간·메모리·실패율을 측정하세요. 캐시는 문서 해시와 모델·런타임 버전으로 재사용하며 원본 PDF는 저장하지 않습니다. 원본 문구를 반환하지 않는 geometry API이지만 좌표 캐시도 서버 접근 권한 아래 두세요.

공식 Docling Serve와 다른 API 계약입니다. `/v1/info`, `/v1/layout/<SHA256>` 조회·분석만 사용하며, 서버 교체 시 동일한 좌표·분류 스키마를 유지해야 합니다. 서버의 모델·라이브러리 버전이 바뀌면 캐시 식별값도 달라집니다.
