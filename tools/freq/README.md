# 구어 빈도 순위 (교재 검사기 전용)

`tools/check.js`가 교재 단어가 실제 대화에서 자주 쓰이는지 확인할 때만 읽는 파일입니다. 앱은 불러오지 않습니다.

- 출처: FrequencyWords (Hermit Dave), 2018 영어 목록 `en_50k.txt`
  https://github.com/hermitdave/FrequencyWords (OpenSubtitles 2018 영화, 드라마 자막 기반)
- 라이선스: 자료는 CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), 코드는 MIT
- 변경: 원본 5만 줄 중 위에서 2만 줄만 잘라 냄. 이 파일도 CC BY-SA 4.0을 따릅니다.

형식: `단어 등장횟수`, 줄 번호가 순위입니다.

레벨별 상한: L1 2,000 / L2 4,000 / L3 7,000 / L4 10,000 / L5 15,000위.
영화 대사 자료라 메뉴, 쿠폰, 환불처럼 생활 거래 단어는 실제보다 드물게 나옵니다. 이런 단어는 유닛의 `situational`에 넣습니다.
