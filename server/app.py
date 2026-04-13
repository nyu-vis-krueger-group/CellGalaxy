from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import DATA_DIR, CACHE_DIR, ZARR_DIR
from .routes_upload import router as upload_router
from .routes_meta import router as meta_router
from .routes_atlas import router as atlas_router
from .routes_features import router as features_router
from .routes_violin import router as violin_router
from .routes_llm import router as llm_router


def create_app() -> FastAPI:
    """Create and configure FastAPI application instance."""
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.mount(
        "/output.zarr",
        StaticFiles(directory=ZARR_DIR, check_dir=False),
        name="zarr_data",
    )
    app.mount(
        "/public/cache",
        StaticFiles(directory=CACHE_DIR, check_dir=False),
        name="cache_files",
    )
    app.mount(
        "/public",
        StaticFiles(directory=DATA_DIR, check_dir=False),
        name="public_files",
    )

    @app.get("/")
    async def root():
        return {"message": "API is running"}

    app.include_router(upload_router)
    app.include_router(meta_router)
    app.include_router(atlas_router)
    app.include_router(features_router)
    app.include_router(violin_router)
    app.include_router(llm_router)
    return app


app = create_app()
