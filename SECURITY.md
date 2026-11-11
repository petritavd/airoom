# Security

airoom runs a local server that can execute Claude Code on your machine, with
tool permissions bypassed when you say so. That makes two kinds of finding
worth reporting privately:

- anything that lets a web page, another process or another machine reach that
  server (it binds 127.0.0.1 and must stay that way);
- anything that could make airoom.dev or its download redirect hand out a
  build we did not publish.

Email hello@airoom.dev with "security" in the subject. A person reads that
inbox; expect an answer within a week, and a fix or a timeline after that.
There is no bounty programme. Credit in the release notes is offered instead.

Please do not open a public issue for a vulnerability until a fix is out.
