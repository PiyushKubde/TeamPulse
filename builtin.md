# viaSocket skill · built-in actions

Back to the skill: https://viasocket.com/docs/skill.md?format=sdk

Actions viaSocket runs itself, so the product needs no second service for them: an AI call, a wait, a
translation, a PDF, a currency rate. Most need no sign-in: send the word `NoAuth` as the `auth_id` (to enable,
to run, to register in a step). The rows that say "the user connects it" need a connection like any other app.
A row with `pauses` set (`delay`: a set time; `async`: the app’s callback; `intervention`: a person), the same field
the listing answers, runs only as
a step of a flow: the flow stops there and its next step runs when the wait ends.

Run one from code like any action (https://viasocket.com/docs/apps-api.md?format=sdk), or register it in a step of an automation (https://viasocket.com/docs/automations.md?format=sdk).

## Utilities

| Built in | Use it to | app slug · event | key | `action_id` | `auth_id` | `pauses` |
| --- | --- | --- | --- | --- | --- | --- |
| Run AI Model | Write, classify, extract, read a page it is given a URL for, or search the web; the prompt decides the job. | `viasocket-utilities` · `run-ai-model` | `Run_AI_Model` `v3` | `rowskkqydb6f` | `NoAuth` |  |
| Delay ("Pause Workflow") | Wait a fixed time before the next step. | `viasocket-utilities` · `pause-workflow` | `Pause_Workflow` `v31` | `row6hurrxf00` | `NoAuth` | `delay` |
| Memory | Keep a value between runs (key-value storage): the last id seen, a counter, a setting. | `memory` · `memory` | `Memory` `v3` | `rown00e31rlb` | the user connects it |  |
| Send SMS | Send an SMS to a phone number. | `sms` · `send-sms` | `Send_SMS` `v14` | `row7kkf59dv5` | the user connects it |  |

## AI

| Built in | Use it to | app slug · event | key | `action_id` | `auth_id` | `pauses` |
| --- | --- | --- | --- | --- | --- | --- |
| AI Image Generator | Create or edit images with AI | `image-generator` · `ai-image-generator` | `AI_Image_Generator` `v8` | `rowmjzkcfmmx` | the user connects it | `async` |
| Decision Maker | Evaluate input using configured yes/no, choice, or score questions and return decisions with confidence. | `decisionmaker` · `decision-maker` | `Decision_Maker` `v4` | `row1yu6cpp0q` | the user connects it |  |
| Add Audio to Image | Combine an image and an audio track to create a video. | `audio-image` · `add-audio-to-image` | `Add_Audio_to_Image` `v4` | `rowyks7n6hdh` | `NoAuth` |  |
| Transcribe Audio | Convert an audio file into a transcript with tone, a short summary, and key points. | `speech-to-text` · `transcribe-audio` | `Transcribe_Audio` `v10` | `rowchi48nmy6` | `NoAuth` |  |
| Translate Text | Translates the provided text into the selected language. | `text_translater` · `translate-text` | `Translate_Text` `v3` | `rowcyx7qgysg` | `NoAuth` |  |

## Business / Government Services

| Built in | Use it to | app slug · event | key | `action_id` | `auth_id` | `pauses` |
| --- | --- | --- | --- | --- | --- | --- |
| Convert Currency | Convert amount at current rate | `converter` · `convert-currency` | `Convert_Currency` `v3` | `rowk8wy7wf92` | `NoAuth` |  |
| Get GST Details | Inlined GST lookup logic with GSTIN validation, recursive flattening, and real API error surfacing. | `giddh_gst` · `get-gst-details` | `Get_GST_Details` `v3` | `rownt5yjerdb` | `NoAuth` |  |

## Documents / Data Parsing

| Built in | Use it to | app slug · event | key | `action_id` | `auth_id` | `pauses` |
| --- | --- | --- | --- | --- | --- | --- |
| Convert HTML to PDF | Convert HTML input into a PDF file. | `pdf_generator` · `convert-html-to-pdf` | `Convert_HTML_to_PDF` `v7` | `rowez7rnrrsd` | `NoAuth` |  |
| Convert to JSON | Converts text or key-value inputs into a structured format usable by other tools. | `json_converter` · `convert-to-json` | `Convert_to_JSON` `v4` | `row54shumutg` | the user connects it |  |
| Summarize Text | Create a concise summary of the provided text. | `text_summarizer` · `summarize-text` | `Summarize_Text` `v3` | `row1z1uega4f` | `NoAuth` |  |

## Messaging

| Built in | Use it to | app slug · event | key | `action_id` | `auth_id` | `pauses` |
| --- | --- | --- | --- | --- | --- | --- |
| Send WhatsApp Message | Send text, media, template, or bulk messages to a chosen WhatsApp contact or group. | `whatsapp` · `send-whatsapp-message` | `Send_WhatsApp_Message` `v17` | `row0e05l0i9o` | the user connects it |  |

## Network / Web

| Built in | Use it to | app slug · event | key | `action_id` | `auth_id` | `pauses` |
| --- | --- | --- | --- | --- | --- | --- |
| Extract Website Data | Extract data from a website and return it in specified formats. | `WebScrapingOrCrawling` · `extract-website-data` | `Extract_Website_Data` `v21` | `rowgwfy8tllu` | `NoAuth` |  |
| LinkedIn Profile Scraper | Extract key fields (name, headline, company, location, experience, education, image) from a public LinkedIn p… | `linkdinscraper` · `linkedin-profile-scraper` | `LinkedIn_Profile_Scraper` `v4` | `rowj60i92jbu` | the user connects it | `async` |
| Resume Parser | Extract a candidate's name, contact info, skills, work experience, and education from a resume or CV (PDF, DO… | `resumeinbuilt` · `resume-parser` | `Resume_Parser` `v6` | `row82cu6u8sb` | `NoAuth` | `async` |

## Scripting

| Built in | Use it to | app slug · event | key | `action_id` | `auth_id` | `pauses` |
| --- | --- | --- | --- | --- | --- | --- |
| Convert File | Convert file URLs to Base64 or Base64/Data URI to hosted files. | `Url_builder` · `convert-file` | `Convert_File` `v2` | `rowi0unfj54s` | the user connects it |  |

**Browser use for an AI agent** is not a catalog action: it is built into AI in the product,
https://viasocket.com/docs/ai.md?format=sdk.

An automation step takes the `action_id`. Code that runs one names it by its key and version, as
`user.listActions('<app slug>')` lists them; each action's page is `https://viasocket.com/docs/<app slug>/<event>.md`, with its input as a type.

Ids, keys and values: https://viasocket.com/docs/skill/actions-and-events.md?format=sdk.

END OF PAGE
