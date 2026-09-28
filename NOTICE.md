# License and attribution

This repository is the source of **[chenbao.tech](https://chenbao.tech)**, the homepage of Chen Bao (鲍辰).
It contains the author's code, the author's 3D model and artwork, personal content, and third-party
components. They are licensed differently:

| What | Files | License |
|---|---|---|
| Site code | the HTML markup and inline scripts of `index.html`, `js/main.js`, `js/ride.js`, `js/ui.js`, `css/site.css` | [MIT](LICENSE) |
| 3D model and artwork | `assets/car.glb` (the suspended monorail car), `assets/layers/*` (the night-city parallax layers), `assets/poster.jpg`, `assets/poster-portrait.jpg` | [CC BY 4.0](LICENSES/CC-BY-4.0.txt) |
| Personal content | the text of the pages (bio, news, publication list, awards), `images/sfphoto.jpg`, `images/1.webp`, `files/chenbao_resume.pdf`, `life.html`, `videos.json` | © Chen Bao, all rights reserved |
| Paper and project media | `images/research/*`, `assets/papers/*`, `assets/projects/*`, `oasis2200/*` | © their respective authors and teams; not licensed here |
| Third-party components | see [below](#third-party-components) | their own licenses |

## How to credit

If you reuse the code, or build a site based on this one, keep the MIT copyright notice in your copy and
please also credit it visibly with a link:

> Based on [chenbao.tech](https://chenbao.tech) by Chen Bao

The 3D model and artwork are licensed under CC BY 4.0, which requires attribution. Use for example:

> "Suspended monorail car" by Chen Bao ([chenbao.tech](https://chenbao.tech)), licensed under
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

Name the work you use (e.g. "Night-city layers"), link to https://chenbao.tech and the license, and say
if you changed it.

## Third-party components

- **three.js** r180, MIT. Loaded from the jsDelivr CDN; not stored in this repository.
- **Fonts** in `assets/fonts/` (subsets of Barlow Semi Condensed, IBM Plex Sans / Mono and Noto Sans SC),
  SIL Open Font License 1.1. Copyright notices and the license text: [`assets/fonts/OFL.txt`](assets/fonts/OFL.txt).
- **Font Awesome Free 5.9.0** (`font-awesome-5.9.0/`, and the brand icons inlined as SVG in `index.html`):
  icons CC BY 4.0, code MIT. See https://fontawesome.com/license/free.
- **Bootstrap 3.1.1** and **normalize.css 3.0.0** (`css/bootstrap.css`), MIT.
- **MenuSpy 1.3.0**, modified (`js/menuspy.js`), MIT, Copyright (c) 2018 Leonardo Santos.
- `css/style.css` comes from the previous site template and is not covered by this repository's licenses.
- Libraries bundled inside `oasis2200/` keep their own licenses.
