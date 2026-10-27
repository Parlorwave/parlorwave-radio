class _Config(dict):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)


class EntitySelectorConfig(_Config):
    pass


class SelectSelectorConfig(_Config):
    pass


class SelectSelectorMode:
    LIST = "list"
    DROPDOWN = "dropdown"


class _Selector:
    def __init__(self, config=None):
        self.config = config or {}


class EntitySelector(_Selector):
    pass


class SelectSelector(_Selector):
    pass
