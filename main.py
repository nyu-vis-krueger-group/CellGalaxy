import logging

import uvicorn

from server.app import app


class _SkipGeneratingPollFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "/upload/generating" not in record.getMessage()


if __name__ == "__main__":
    logging.getLogger("uvicorn.access").addFilter(_SkipGeneratingPollFilter())
    uvicorn.run(app, host="0.0.0.0", port=8000)


